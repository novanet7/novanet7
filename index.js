const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const flash = require('connect-flash');
const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Octokit } = require('@octokit/rest');
const config = require('./setting.js');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const SITE_NAME = config.SITE_NAME || 'novanet';
const PORT = config.PORT || 8080;
const HOST = config.HOST || '0.0.0.0';
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});
const JWT_SECRET = config.JWT_SECRET || config.SESSION_SECRET || 'novabot-jwt-secret-2026';

let GITHUB_TOKEN = null;
let GITHUB_REPO = null;
let GITHUB_BRANCH = 'main';
let GITHUB_PATH = 'data';
let octokit = null;
let owner, repo;
const sessionCache = new Map();

// ==================== HELPER RENDER HTML ====================
function renderHTML(fileName, replacements = {}) {
    const filePath = path.join(__dirname, 'public', fileName);
    let content = fs.readFileSync(filePath, 'utf8');
    for (const [key, value] of Object.entries(replacements)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        content = content.replace(regex, value);
    }
    return content;
}

// ============================================================================
// KELAS GITHUB SESSION STORE
// ============================================================================
class GitHubSessionStore extends session.Store {
  constructor(octokit, owner, repo, branch, sessionPath) {
    super();
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.sessionPath = sessionPath;
  }

  getFilePath(sid) {
    return `${this.sessionPath}/${sid}.jwt`.replace(/\/+/g, '/');
  }

  async _readSession(sid) {
    const filePath = this.getFilePath(sid);
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: this.branch,
      });
      const jwtToken = Buffer.from(data.content, 'base64').toString();
      const decoded = jwt.verify(jwtToken, JWT_SECRET);
      if (decoded.session && decoded.session.cookie && decoded.session.cookie.expires) {
        const expires = new Date(decoded.session.cookie.expires);
        if (expires < new Date()) {
          return null;
        }
      }
      return decoded.session;
    } catch (err) {
      if (err.status === 404) return null;
      console.error(`Error reading session ${sid}:`, err);
      return null;
    }
  }

  async _writeSession(sid, session) {
    const filePath = this.getFilePath(sid);
    let maxAge = (session.cookie && session.cookie.maxAge) || 30 * 24 * 60 * 60 * 1000;
    const expiresIn = Math.floor(maxAge / 1000);
    const payload = { session, sid };
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn });
    let sha = null;
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: this.branch,
      });
      sha = data.sha;
    } catch (err) { /* file belum ada */ }
    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: filePath,
      message: `Session update: ${sid}`,
      content: Buffer.from(jwtToken).toString('base64'),
      branch: this.branch,
      sha: sha,
    });
  }

  get(sid, callback) {
    const cached = sessionCache.get(sid);
    if (cached && cached.expireAt > Date.now()) {
      return callback(null, cached.session);
    } else if (cached) {
      sessionCache.delete(sid);
    }
    this._readSession(sid)
      .then(session => {
        if (session) {
          const maxAge = (session.cookie && session.cookie.maxAge) || 30 * 24 * 60 * 60 * 1000;
          sessionCache.set(sid, { session, expireAt: Date.now() + maxAge });
        }
        callback(null, session);
      })
      .catch(err => callback(err));
  }

  set(sid, session, callback) {
    this._writeSession(sid, session)
      .then(() => {
        const maxAge = (session.cookie && session.cookie.maxAge) || 30 * 24 * 60 * 60 * 1000;
        sessionCache.set(sid, { session, expireAt: Date.now() + maxAge });
        callback(null);
      })
      .catch(err => callback(err));
  }

  destroy(sid, callback) {
    const filePath = this.getFilePath(sid);
    this.octokit.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path: filePath,
      ref: this.branch,
    })
      .then(({ data }) => {
        return this.octokit.repos.deleteFile({
          owner: this.owner,
          repo: this.repo,
          path: filePath,
          message: `Delete session: ${sid}`,
          sha: data.sha,
          branch: this.branch,
        });
      })
      .then(() => {
        sessionCache.delete(sid);
        callback(null);
      })
      .catch(err => {
        if (err.status === 404) callback(null);
        else callback(err);
      });
  }

  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }
}

let sessionStore = null;

// ============================================================================
// MIDDLEWARE DASAR
// ============================================================================
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cookieParser());

// ============================================================================
// TELEGRAM NOTIFIER
// ============================================================================
async function sendTelegramError(error, context = {}) {
  try {
    const now = new Date();
    const formatterDay = new Intl.DateTimeFormat('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' });
    const dayName = formatterDay.format(now);
    const formatterDate = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jakarta' });
    const dateStr = formatterDate.format(now).replace(/\//g, '-');
    const formatterTime = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' });
    const timeStr = formatterTime.format(now);
    const msg = `<blockquote>🧑‍🔧 ERROR DI ${SITE_NAME} PANEL</blockquote>\n\n` +
      `<b>Waktu:</b> ${dayName}, ${dateStr} ${timeStr}\n` +
      `<b>Context:</b> <code>${JSON.stringify(context, null, 2)}</code>\n` +
      `<b>Message:</b> <code>${error.message}</code>\n` +
      `<b>Stack:</b> <code>${error.stack?.slice(0, 500) || 'tidak ada'}</code>`;
    const replyMarkup = {
      inline_keyboard: [
        [{ text: '🌐 Buka Website', url: config.URL }]
      ]
    };
    await fetch(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.OWNER_ID,
        text: msg,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      })
    });
  } catch (e) {
    console.error('Gagal kirim notifikasi error ke Telegram:', e);
  }
}

// ============================================================================
// FUNGSI BACA/TULIS GITHUB (DENGAN RETRY)
// ============================================================================
async function readGitHubFile(filePath) {
  if (!octokit) throw new Error('GitHub tidak tersedia');
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: GITHUB_BRANCH,
    });
    const content = Buffer.from(data.content, 'base64').toString();
    return { content: JSON.parse(content), sha: data.sha };
  } catch (error) {
    if (error.status === 404) {
      return { content: null, sha: null };
    }
    throw error;
  }
}
async function writeGitHubFile(filePath, content, sha = null, message = 'Update file') {
  if (!octokit) throw new Error('GitHub tidak tersedia');
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    branch: GITHUB_BRANCH,
    sha,
  });
}
async function writeGitHubFileWithRetry(filePath, content, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { sha } = await readGitHubFile(filePath);
      await writeGitHubFile(filePath, content, sha, 'Update file');
      return;
    } catch (error) {
      if (error.status === 409 && i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}

// ============================================================================
// MANAJEMEN ORDER DI GITHUB
// ============================================================================
async function getOrders() {
  const filePath = `${GITHUB_PATH}/orders.json`.replace(/\/+/g, '/');
  const { content } = await readGitHubFile(filePath);
  return content || [];
}
async function saveOrders(orders) {
  const filePath = `${GITHUB_PATH}/orders.json`.replace(/\/+/g, '/');
  await writeGitHubFileWithRetry(filePath, orders);
}
async function getCancelledOrders() {
  const filePath = `${GITHUB_PATH}/cancelled_orders.json`.replace(/\/+/g, '/');
  const { content } = await readGitHubFile(filePath);
  return content || [];
}
async function saveCancelledOrders(orders) {
  const filePath = `${GITHUB_PATH}/cancelled_orders.json`.replace(/\/+/g, '/');
  await writeGitHubFileWithRetry(filePath, orders);
}
async function findAllOrders() {
  const active = await getOrders();
  const cancelled = await getCancelledOrders();
  return [...active, ...cancelled];
}
async function findOrderById(orderId) {
  const active = await getOrders();
  const cancelled = await getCancelledOrders();
  return active.find(o => o.order_id === orderId) || cancelled.find(o => o.order_id === orderId);
}
async function addOrder(order) {
  const orders = await getOrders();
  orders.push(order);
  await saveOrders(orders);
  return order;
}
async function updateOrder(orderId, updates) {
  const orders = await getOrders();
  const index = orders.findIndex(o => o.order_id === orderId);
  if (index === -1) throw new Error('Order tidak ditemukan');
  orders[index] = { ...orders[index], ...updates };
  await saveOrders(orders);
  return orders[index];
}
async function deleteOrdersByEmail(email) {
  const orders = await getOrders();
  const newOrders = orders.filter(o => o.email !== email);
  await saveOrders(newOrders);
  const cancelled = await getCancelledOrders();
  const newCancelled = cancelled.filter(o => o.email !== email);
  await saveCancelledOrders(newCancelled);
}

// ============================================================================
// MANAJEMEN REFUND REQUEST
// ============================================================================
async function getRefundRequests() {
  const filePath = `${GITHUB_PATH}/refund_requests.json`.replace(/\/+/g, '/');
  const { content } = await readGitHubFile(filePath);
  return content || [];
}
async function saveRefundRequests(requests) {
  const filePath = `${GITHUB_PATH}/refund_requests.json`.replace(/\/+/g, '/');
  await writeGitHubFileWithRetry(filePath, requests);
}
async function addRefundRequest(order, danaData) {
  const requests = await getRefundRequests();
  requests.push({
    order_id: order.order_id,
    email: order.email,
    panel_type: order.panel_type,
    amount: order.amount,
    requested_at: new Date().toISOString(),
    status: 'pending',
    dana_number: danaData.dana_number,
    dana_name: danaData.dana_name,
    reason: danaData.reason || ''
  });
  await saveRefundRequests(requests);
}
async function removeRefundRequest(orderId) {
  const requests = await getRefundRequests();
  const newRequests = requests.filter(r => r.order_id !== orderId);
  await saveRefundRequests(newRequests);
}
async function findRefundRequest(orderId) {
  const requests = await getRefundRequests();
  return requests.find(r => r.order_id === orderId);
}

// ============================================================================
// RATE LIMITING UNTUK REGISTER (DISIMPAN DI GITHUB)
// ============================================================================
const RATE_LIMIT_FILE = `${GITHUB_PATH}/rate_limits.json`.replace(/\/+/g, '/');

async function getRateLimits() {
  try {
    const { content } = await readGitHubFile(RATE_LIMIT_FILE);
    return content || {};
  } catch {
    return {};
  }
}
async function saveRateLimits(limits) {
  await writeGitHubFileWithRetry(RATE_LIMIT_FILE, limits);
}
async function cleanExpiredRateLimits() {
  const limits = await getRateLimits();
  const now = Date.now();
  let changed = false;
  for (const [ip, data] of Object.entries(limits)) {
    if (data.blockedUntil && now > data.blockedUntil) {
      delete limits[ip];
      changed = true;
    } else if (!data.blockedUntil && now - data.firstAttempt > 5 * 60 * 1000) {
      delete limits[ip];
      changed = true;
    }
  }
  if (changed) await saveRateLimits(limits);
}
async function isRegisterBlocked(ip) {
  await cleanExpiredRateLimits();
  const limits = await getRateLimits();
  const data = limits[ip];
  return data && data.blockedUntil && Date.now() < data.blockedUntil;
}
async function registerAttempt(ip) {
  await cleanExpiredRateLimits();
  const limits = await getRateLimits();
  const now = Date.now();
  let data = limits[ip];
  if (!data) {
    data = { count: 1, firstAttempt: now, blockedUntil: null };
    limits[ip] = data;
    await saveRateLimits(limits);
    return { blocked: false, remaining: 4 };
  }
  if (data.blockedUntil && now < data.blockedUntil) {
    return { blocked: true, remaining: 0 };
  }
  if (now - data.firstAttempt > 5 * 60 * 1000) {
    data.count = 1;
    data.firstAttempt = now;
    data.blockedUntil = null;
    limits[ip] = data;
    await saveRateLimits(limits);
    return { blocked: false, remaining: 4 };
  }
  data.count++;
  if (data.count >= 5) {
    data.blockedUntil = now + 5 * 60 * 1000;
    limits[ip] = data;
    await saveRateLimits(limits);
    return { blocked: true, remaining: 0 };
  }
  limits[ip] = data;
  await saveRateLimits(limits);
  return { blocked: false, remaining: 5 - data.count };
}
async function clearRegisterAttempts(ip) {
  const limits = await getRateLimits();
  if (limits[ip]) {
    delete limits[ip];
    await saveRateLimits(limits);
  }
}

// ============================================================================
// MANAJEMEN USER PER FILE
// ============================================================================
const USERS_INDEX_PATH = `${GITHUB_PATH}/users_index.json`.replace(/\/+/g, '/');
async function getUsersIndex() {
  const { content } = await readGitHubFile(USERS_INDEX_PATH);
  return content || [];
}
async function saveUsersIndex(index) {
  await writeGitHubFileWithRetry(USERS_INDEX_PATH, index);
}
async function getUserFilePath(userId) {
  return `${GITHUB_PATH}/users/${userId}.json`.replace(/\/+/g, '/');
}
async function readUserFile(userId) {
  const filePath = await getUserFilePath(userId);
  const { content } = await readGitHubFile(filePath);
  return content;
}
async function writeUserFile(userId, userData) {
  const filePath = await getUserFilePath(userId);
  await writeGitHubFileWithRetry(filePath, userData);
}
async function deleteUserFile(userId) {
  const filePath = await getUserFilePath(userId);
  try {
    const { sha } = await readGitHubFile(filePath);
    await octokit.repos.deleteFile({
      owner, repo, path: filePath, message: `Delete user ${userId}`,
      sha, branch: GITHUB_BRANCH
    });
  } catch (err) { console.error(`Gagal hapus file user ${userId}:`, err); }
}
async function getUsers() {
  const index = await getUsersIndex();
  const users = [];
  for (const item of index) {
    const user = await readUserFile(item.id);
    if (user) users.push(user);
  }
  return users;
}
async function findUserByEmail(email) {
  const index = await getUsersIndex();
  const found = index.find(u => u.email === email);
  if (!found) return null;
  return await readUserFile(found.id);
}
async function findUserById(id) {
  const index = await getUsersIndex();
  if (!index.some(u => u.id === id)) return null;
  return await readUserFile(id);
}

// ============================================================================
// FUNGSI AMBIL FOTO RANDOM DARI WAIFU.PICS (TANPA FALLBACK)
// ============================================================================
async function fetchRandomAvatarFromWaifu() {
  try {
    const response = await fetch('https://api.waifu.pics/sfw/waifu');
    if (!response.ok) throw new Error('Gagal mengambil gambar dari waifu.pics');
    const data = await response.json();
    const imageUrl = data.url;
    if (!imageUrl) throw new Error('URL gambar tidak ditemukan');
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error('Gagal download gambar');
    // Gunakan arrayBuffer lalu konversi ke Buffer
    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = mimeType.split('/')[1] || 'jpg';
    const fileName = `avatar.${ext}`;
    return { buffer, mimeType, fileName };
  } catch (err) {
    console.error('Error fetching waifu image:', err);
    throw new Error('Gagal mengambil avatar random anime dari waifu.pics');
  }
}

// ============================================================================
// ID RANDOM 4 DIGIT (1000-9999) & UNIK
// ============================================================================
async function generateUniqueRandomId() {
  const index = await getUsersIndex();
  const existingIds = new Set(index.map(u => u.id));
  let attempts = 0;
  while (attempts < 20) {
    const randomId = Math.floor(Math.random() * 9000) + 1000;
    if (!existingIds.has(randomId)) return randomId;
    attempts++;
  }
  for (let i = 1000; i <= 9999; i++) {
    if (!existingIds.has(i)) return i;
  }
  throw new Error('Tidak ada ID yang tersedia (1000-9999 penuh)');
}

// ============================================================================
// CREATE USER (DENGAN PASTIKAN UPLOAD FOTO SELESAI)
// ============================================================================
async function createUser(userData) {
  const newId = await generateUniqueRandomId();
  let photoPath = userData.photo || '';
  
  if (!photoPath) {
    try {
      const { buffer, mimeType, fileName } = await fetchRandomAvatarFromWaifu();
      const tempUser = { id: newId };
      photoPath = await uploadAvatarToGitHub(tempUser, buffer, fileName, mimeType);
      console.log(`✅ Avatar random berhasil diupload untuk user ${newId}: ${photoPath}`);
    } catch (err) {
      console.error('Gagal upload foto random anime untuk user baru:', err);
      photoPath = '';
    }
  }
  
  const newUser = {
    id: newId,
    ...userData,
    createdAt: new Date().toISOString(),
    purchasedPanels: [],
    pterodactylUserId: null,
    photo: photoPath
  };
  
  await writeUserFile(newId, newUser);
  console.log(`✅ Data user ${newId} berhasil disimpan ke GitHub`);
  
  const index = await getUsersIndex();
  index.push({ id: newId, email: newUser.email, name: newUser.name });
  await saveUsersIndex(index);
  
  // Verifikasi data user
  const verifyUser = await readUserFile(newId);
  if (!verifyUser || verifyUser.photo !== photoPath) {
    console.error(`⚠️ Verifikasi gagal untuk user ${newId}`);
  } else {
    console.log(`✅ Verifikasi user ${newId} OK, photo: ${verifyUser.photo}`);
  }
  
  return newUser;
}

async function updateUser(id, updatedFields) {
  const user = await findUserById(id);
  if (!user) throw new Error('User tidak ditemukan');
  const updatedUser = { ...user, ...updatedFields };
  await writeUserFile(id, updatedUser);
  if (updatedFields.name || updatedFields.email) {
    const index = await getUsersIndex();
    const idx = index.findIndex(u => u.id === id);
    if (idx !== -1) {
      if (updatedFields.name) index[idx].name = updatedFields.name;
      if (updatedFields.email) index[idx].email = updatedFields.email;
      await saveUsersIndex(index);
    }
  }
  return updatedUser;
}
async function deleteUserById(id) {
  const user = await findUserById(id);
  if (!user) throw new Error('User tidak ditemukan');
  await deleteOrdersByEmail(user.email);
  await deleteUserFile(id);
  const index = await getUsersIndex();
  const newIndex = index.filter(u => u.id !== id);
  await saveUsersIndex(newIndex);
  await deleteUserAvatar(id);
}

// ============================================================================
// UPLOAD AVATAR KE GITHUB (DENGAN VERIFIKASI)
// ============================================================================
async function uploadAvatarToGitHub(user, fileBuffer, fileName, mimeType) {
  if (!octokit) throw new Error('GitHub tidak tersedia');
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
  if (!allowedTypes.includes(mimeType)) {
    throw new Error('Format file tidak didukung. Gunakan jpg, jpeg, png, gif, webp, atau bmp.');
  }
  const ext = fileName.split('.').pop().toLowerCase();
  const avatarPath = `avatars/${user.id}/avatar.${ext}`;
  
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: avatarPath,
    message: `Upload avatar for user ${user.id}`,
    content: fileBuffer.toString('base64'),
    branch: GITHUB_BRANCH
  });
  
  // Verifikasi apakah file benar-benar ada
  try {
    const { data } = await octokit.repos.getContent({
      owner, repo, path: avatarPath, ref: GITHUB_BRANCH
    });
    if (data && data.content) {
      console.log(`✅ Verifikasi avatar untuk user ${user.id} berhasil: ${avatarPath}`);
    } else {
      console.warn(`⚠️ Verifikasi avatar gagal untuk user ${user.id}`);
    }
  } catch (err) {
    console.error(`❌ Verifikasi avatar error: ${err.message}`);
    throw new Error('Gagal verifikasi upload avatar');
  }
  
  return avatarPath;
}
async function deleteUserAvatar(userId) {
  if (!octokit) return;
  const folder = `avatars/${userId}`;
  try {
    const { data: files } = await octokit.repos.getContent({
      owner,
      repo,
      path: folder,
      ref: GITHUB_BRANCH
    }).catch(() => ({ data: null }));
    if (files && Array.isArray(files)) {
      for (const file of files) {
        if (file.type === 'file') {
          await octokit.repos.deleteFile({
            owner,
            repo,
            path: file.path,
            message: `Delete avatar for user ${userId}`,
            sha: file.sha,
            branch: GITHUB_BRANCH
          });
        }
      }
    }
  } catch (err) {
    console.error(`Gagal hapus avatar user ${userId}:`, err);
  }
}

// ============================================================================
// PASSPORT CONFIGURATION
// ============================================================================
passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  try {
    const user = await findUserById(id);
    if (!user) {
      console.warn(`⚠️ User dengan ID ${id} tidak ditemukan di GitHub`);
      return done(null, false);
    }
    done(null, user);
  } catch (err) {
    console.error('❌ Deserialize error:', err);
    await sendTelegramError(err, { fungsi: 'deserializeUser', id });
    done(err, null);
  }
});
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const user = await findUserByEmail(email);
    if (!user) {
      console.warn(`❌ User tidak ditemukan: ${email}`);
      return done(null, false, { message: 'Email tidak terdaftar' });
    }
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      console.warn(`❌ Password salah untuk: ${email}`);
      return done(null, false, { message: 'Password salah' });
    }
    return done(null, user);
  } catch (err) {
    console.error('❌ LocalStrategy error:', err);
    await sendTelegramError(err, { fungsi: 'LocalStrategy', email });
    return done(err);
  }
}));
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  req.flash('error', 'Silakan login terlebih dahulu');
  res.redirect('/login');
}
function isAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.email === config.ADMIN_EMAIL) {
    return next();
  }
  req.flash('error', 'Akses ditolak. Hanya admin yang diizinkan.');
  res.redirect('/profile');
}

// ============================================================================
// CREATE / FIND PTERODACTYL USER
// ============================================================================
async function findPterodactylUserByEmail(email) {
  try {
    const response = await fetch(`${config.DOMAIN}/api/application/users?filter[email]=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${config.PLTA}`
      }
    });
    const data = await response.json();
    if (data.data && data.data.length > 0) {
      const user = data.data[0].attributes;
      return { success: true, userId: user.id, username: user.username, email: user.email };
    }
    return { success: false, message: 'User tidak ditemukan' };
  } catch (error) {
    console.error('Find Pterodactyl user error:', error);
    await sendTelegramError(error, { fungsi: 'findPterodactylUserByEmail', email });
    return { success: false, error: error.message };
  }
}
async function createPterodactylUser(email, username, password) {
  try {
    const response = await fetch(`${config.DOMAIN}/api/application/users`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.PLTA}`
      },
      body: JSON.stringify({
        email: email,
        username: username,
        first_name: username,
        last_name: 'User',
        password: password
      })
    });
    const data = await response.json();
    if (data.errors) {
      throw new Error(data.errors[0].detail || 'Gagal membuat user');
    }
    return {
      success: true,
      userId: data.attributes.id,
      username: data.attributes.username,
      email: data.attributes.email,
      password: password
    };
  } catch (error) {
    console.error('Create Pterodactyl user error:', error);
    await sendTelegramError(error, { fungsi: 'createPterodactylUser', email, username });
    throw error;
  }
}

// ============================================================================
// CREATE PTERODACTYL SERVER
// ============================================================================
async function createPterodactylServer(userId, panelType, username, email) {
  try {
    let ram, disk, cpu;
    if (panelType === 'unli') {
      ram = 0; disk = 0; cpu = 0;
    } else {
      switch (panelType) {
        case '1gb': ram = 1024; disk = 1024; cpu = 40; break;
        case '2gb': ram = 2048; disk = 2048; cpu = 60; break;
        case '3gb': ram = 3072; disk = 3072; cpu = 80; break;
        case '4gb': ram = 4096; disk = 4096; cpu = 100; break;
        case '5gb': ram = 5120; disk = 5120; cpu = 120; break;
        case '6gb': ram = 6144; disk = 6144; cpu = 140; break;
        case '7gb': ram = 7168; disk = 7168; cpu = 160; break;
        case '8gb': ram = 8192; disk = 8192; cpu = 180; break;
        case '9gb': ram = 9216; disk = 9216; cpu = 200; break;
        case '10gb': ram = 10240; disk = 10240; cpu = 220; break;
        default: ram = 1024; disk = 1024; cpu = 40;
      }
    }
    const now = new Date();
    const formatterDay = new Intl.DateTimeFormat('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' });
    const dayName = formatterDay.format(now);
    const formatterDate = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jakarta' });
    const dateStr = formatterDate.format(now).replace(/\//g, '-');
    const formatterTime = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' });
    const timeStr = formatterTime.format(now);
    const description = `Dibuat dengan web ${SITE_NAME} ${dayName}, ${dateStr} ${timeStr}`;
    const serverName = `${username}`;
    const serverResponse = await fetch(`${config.DOMAIN}/api/application/servers`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.PLTA}`
      },
      body: JSON.stringify({
        name: serverName,
        description: description,
        user: userId,
        egg: parseInt(config.EGG),
        docker_image: 'ghcr.io/parkervcp/yolks:nodejs_20',
        startup: 'npm install && npm start',
        environment: {
          INST: 'npm',
          USER_UPLOAD: '0',
          AUTO_UPDATE: '0',
          CMD_RUN: 'npm start'
        },
        limits: {
          memory: parseInt(ram),
          swap: 0,
          disk: parseInt(disk),
          io: 500,
          cpu: parseInt(cpu)
        },
        feature_limits: {
          databases: 5,
          backups: 5,
          allocations: 1
        },
        deploy: {
          locations: [parseInt(config.LOX)],
          dedicated_ip: false,
          port_range: []
        }
      })
    });
    const serverData = await serverResponse.json();
    if (serverData.errors) {
      throw new Error(serverData.errors[0].detail || 'Gagal membuat server');
    }
    return {
      success: true,
      serverId: serverData.attributes.id,
      identifier: serverData.attributes.identifier,
      name: serverName,
      description: description,
      panelType: panelType,
      ram: ram,
      disk: disk,
      cpu: cpu,
      createdAt: new Date().toISOString(),
      panelUrl: `${config.DOMAIN}`
    };
  } catch (error) {
    console.error('Create Pterodactyl server error:', error);
    await sendTelegramError(error, { fungsi: 'createPterodactylServer', userId, panelType, username, email });
    throw error;
  }
}

// ============================================================================
// DELETE PTERODACTYL SERVER
// ============================================================================
async function deletePterodactylServer(serverId) {
  try {
    const response = await fetch(`${config.DOMAIN}/api/application/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${config.PLTA}`
      }
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `Gagal menghapus server (status ${response.status})`);
    }
    return { success: true };
  } catch (error) {
    console.error('Delete Pterodactyl server error:', error);
    await sendTelegramError(error, { fungsi: 'deletePterodactylServer', serverId });
    return { success: false, error: error.message };
  }
}

// ============================================================================
// FUNGSI CEK STATUS PAKASIR
// ============================================================================
async function checkPaymentStatus(orderId, amount) {
  try {
    const detailUrl = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(config.PAKASIR_PROJECT)}&amount=${amount}&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(config.PAKASIR_API_KEY)}`;
    const response = await fetch(detailUrl);
    const data = await response.json();
    const transaction = data.transaction || {};
    let status = transaction.status || '';
    if (typeof status === 'string') {
      status = status.toLowerCase();
      if (status === 'completed') status = 'paid';
    }
    return {
      success: true,
      status: status,
      transaction: transaction,
      raw: data
    };
  } catch (error) {
    console.error('Check payment status error:', error);
    await sendTelegramError(error, { fungsi: 'checkPaymentStatus', orderId, amount });
    return { success: false, status: 'error' };
  }
}

// ============================================================================
// CANCEL / REFUND ORDER (SESUAI STATUS)
// ============================================================================
async function cancelPakasirTransaction(orderId, amount) {
  try {
    const cancelUrl = 'https://app.pakasir.com/api/transactioncancel';
    const response = await fetch(cancelUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: config.PAKASIR_PROJECT,
        order_id: orderId,
        amount: amount,
        api_key: config.PAKASIR_API_KEY
      })
    });
    const data = await response.json();
    if (!response.ok || data.status !== 'success') {
      throw new Error(data.message || 'Gagal membatalkan transaksi');
    }
    return { success: true, data };
  } catch (error) {
    console.error('Cancel transaction error:', error);
    await sendTelegramError(error, { fungsi: 'cancelPakasirTransaction', orderId, amount });
    return { success: false, error: error.message };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function generateRandomPassword(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
function generateOrderId() {
  return `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
}
function escapeHTML(text) {
  if (!text) return '';
  return text.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
function getGravatarUrl(email, size = 200) {
  const hash = require('crypto').createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
}

// ============================================================================
// SETUP ROUTES (SEMUA ROUTE DENGAN HTML LENGKAP)
// ============================================================================
function setupRoutes(app) {
  // ==========================================================================
  // SITEMAP.XML & ROBOTS.TXT
  // ==========================================================================
  app.get('/sitemap.xml', async (req, res) => {
    const now = new Date().toISOString().split('T')[0];
    const pages = [
      { url: '/', priority: 1.0, changefreq: 'daily', lastmod: now },
      { url: '/login', priority: 0.8, changefreq: 'monthly', lastmod: now },
      { url: '/register', priority: 0.8, changefreq: 'monthly', lastmod: now },
      { url: '/profile', priority: 0.7, changefreq: 'weekly', lastmod: now },
      { url: '/delete-account', priority: 0.5, changefreq: 'yearly', lastmod: now },
      { url: '/payment-callback', priority: 0.6, changefreq: 'yearly', lastmod: now },
      { url: '/admin', priority: 0.6, changefreq: 'weekly', lastmod: now },
    ];
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(page => `  <url>
<loc>${config.URL}${page.url}</loc>
<lastmod>${page.lastmod}</lastmod>
<changefreq>${page.changefreq}</changefreq>
<priority>${page.priority}</priority>
</url>`).join('\n')}
</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(sitemap);
  });

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`# Robot rules for ${SITE_NAME}
User-agent: *
Allow: /
Disallow: /api/
Sitemap: ${config.URL}/sitemap.xml
Crawl-delay: 1
`);
  });

  // ==========================================================================
  // API ROUTES
  // ==========================================================================
  app.post('/api/create-order', isAuthenticated, async (req, res) => {
    try {
      const { panel_type, paneltype } = req.body;
      const panelType = panel_type || paneltype;
      if (!panelType) return res.status(400).json({ success: false, message: 'Tipe panel harus diisi' });
      const email = req.user.email;
      const priceMap = {
        '1gb': config.PRICE_1GB || 500,
        '2gb': config.PRICE_2GB || 500,
        '3gb': config.PRICE_3GB || 500,
        '4gb': config.PRICE_4GB || 500,
        '5gb': config.PRICE_5GB || 500,
        '6gb': config.PRICE_6GB || 500,
        '7gb': config.PRICE_7GB || 500,
        '8gb': config.PRICE_8GB || 500,
        '9gb': config.PRICE_9GB || 500,
        '10gb': config.PRICE_10GB || 500,
        'unli': config.PRICE_UNLI || 500
      };
      const amount = priceMap[panelType] || 500;
      const orderId = generateOrderId();
      const redirectUrl = `${config.URL}/payment-callback?order_id=${orderId}&amount=${amount}`;
      const paymentUrl = `https://app.pakasir.com/pay/${config.PAKASIR_PROJECT}/${amount}?order_id=${orderId}&redirect=${encodeURIComponent(redirectUrl)}&qris_only=1`;
      const order = { order_id: orderId, email: email, panel_type: panelType, amount: amount, status: 'pending', created_at: new Date().toISOString(), panel_created: false };
      await addOrder(order);
      res.json({ success: true, payment_url: paymentUrl, order_id: orderId });
    } catch (error) {
      console.error('Create order error:', error);
      await sendTelegramError(error, { route: '/api/create-order', body: req.body });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  app.get('/api/check-payment/:orderId/:amount', async (req, res) => {
    try {
      const { orderId, amount } = req.params;
      const paymentStatus = await checkPaymentStatus(orderId, parseInt(amount));
      const order = await findOrderById(orderId);
      if (order && paymentStatus.success) await updateOrder(orderId, { status: paymentStatus.status });
      res.json({ success: true, status: paymentStatus.status, order_id: orderId, transaction: paymentStatus.transaction });
    } catch (error) {
      console.error('Check payment error:', error);
      await sendTelegramError(error, { route: '/api/check-payment', orderId, amount });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  app.post('/api/create-panel', async (req, res) => {
    try {
      const { order_id } = req.body;
      if (!order_id) return res.status(400).json({ success: false, message: 'Order ID diperlukan' });
      const order = await findOrderById(order_id);
      if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
      const paymentStatus = await checkPaymentStatus(order_id, order.amount);
      const paidStatuses = ['paid', 'completed'];
      if (!paidStatuses.includes(paymentStatus.status)) return res.status(400).json({ success: false, message: 'Pembayaran belum berhasil. Status: ' + paymentStatus.status });
      if (order.panel_created) return res.status(400).json({ success: false, message: 'Panel sudah dibuat sebelumnya' });
      const username = order.email.split('@')[0];
      const randomPassword = generateRandomPassword(8);
      const user = await findUserByEmail(order.email);
      let pterodactylUserId = null;
      let userResult = null;
      const existingUser = await findPterodactylUserByEmail(order.email);
      if (existingUser.success) {
        pterodactylUserId = existingUser.userId;
        userResult = { success: true, userId: pterodactylUserId };
        if (user && user.pterodactylUserId !== pterodactylUserId) await updateUser(user.id, { pterodactylUserId });
      } else {
        userResult = await createPterodactylUser(order.email, username, randomPassword);
        if (!userResult.success) return res.status(500).json({ success: false, message: 'Gagal membuat user di panel' });
        pterodactylUserId = userResult.userId;
        if (user) await updateUser(user.id, { pterodactylUserId });
      }
      const panelResult = await createPterodactylServer(userResult.userId, order.panel_type, username, order.email);
      if (!panelResult.success) return res.status(500).json({ success: false, message: 'Gagal membuat server' });
      await updateOrder(order_id, { panel_created: true, status: 'paid', panel_data: panelResult, user_data: { email: order.email, username: username, password: randomPassword } });
      if (user) {
        const purchased = user.purchasedPanels || [];
        purchased.push({ order_id: order_id, panel_type: order.panel_type, panel_url: panelResult.panelUrl, username: username, created_at: new Date().toISOString() });
        await updateUser(user.id, { purchasedPanels: purchased });
      }
      res.json({ success: true, panel: panelResult, user: { email: order.email, username: username }, message: 'Panel berhasil dibuat!' });
    } catch (error) {
      console.error('Create panel error:', error);
      await sendTelegramError(error, { route: '/api/create-panel', body: req.body });
      res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
  });

// ==========================================================================
// PAYMENT CALLBACK (dengan file HTML terpisah)
// ==========================================================================
app.get('/payment-callback', async (req, res) => {
  const { order_id, amount } = req.query;
  if (!order_id) {
    return res.redirect('/?error=missing_order');
  }
  const order = await findOrderById(order_id);
  if (!order) {
    return res.redirect('/?error=order_not_found');
  }

  try {
    const paymentStatus = await checkPaymentStatus(order_id, amount || order.amount);
    // Jika status belum paid/completed, kirim data untuk halaman menunggu
    if (paymentStatus.status !== 'paid' && paymentStatus.status !== 'completed') {
      const callbackData = {
        status: paymentStatus.status,
        order_id: order_id,
        error: null,
        panel: null,
        user: null
      };
      const html = renderHTML('payment-callback.html', {
        SITE_NAME: SITE_NAME,
        callbackData: JSON.stringify(callbackData)
      });
      return res.send(html);
    }

    // Jika pembayaran berhasil, pastikan panel sudah dibuat (jika belum, buat)
    if (!order.panel_created) {
      const username = order.email.split('@')[0];
      const randomPassword = generateRandomPassword(8);
      const user = await findUserByEmail(order.email);
      let pterodactylUserId = null;
      let userResult = null;
      const existingUser = await findPterodactylUserByEmail(order.email);
      if (existingUser.success) {
        pterodactylUserId = existingUser.userId;
        userResult = { success: true, userId: pterodactylUserId };
        if (user && user.pterodactylUserId !== pterodactylUserId) {
          await updateUser(user.id, { pterodactylUserId });
        }
      } else {
        userResult = await createPterodactylUser(order.email, username, randomPassword);
        if (!userResult.success) throw new Error('Gagal membuat user');
        pterodactylUserId = userResult.userId;
        if (user) await updateUser(user.id, { pterodactylUserId });
      }
      const panelResult = await createPterodactylServer(userResult.userId, order.panel_type, username, order.email);
      if (!panelResult.success) throw new Error('Gagal membuat server');
      await updateOrder(order_id, {
        panel_created: true,
        status: 'paid',
        panel_data: panelResult,
        user_data: { email: order.email, username: username, password: randomPassword }
      });
      if (user) {
        const purchased = user.purchasedPanels || [];
        purchased.push({
          order_id: order_id,
          panel_type: order.panel_type,
          panel_url: panelResult.panelUrl,
          username: username,
          password: randomPassword,
          created_at: new Date().toISOString()
        });
        await updateUser(user.id, { purchasedPanels: purchased });
      }
      // Kirim notifikasi Telegram (opsional, tetap dijalankan)
      const now = new Date();
      const formatterDay = new Intl.DateTimeFormat('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' });
      const dayName = formatterDay.format(now);
      const formatterDate = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jakarta' });
      const dateStr = formatterDate.format(now).replace(/\//g, '-');
      const formatterTime = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' });
      const timeStr = formatterTime.format(now);
      const formattedTime = `${dayName}, ${dateStr} ${timeStr}`;
      const ownerMsg = `🎉 <b>PANEL BARU DIBUAT</b> 🎉\n\n` +
        `📅 <b>Waktu</b> : ${formattedTime}\n` +
        `📧 <b>Email</b> : <code>${order.email}</code>\n` +
        `👤 <b>Username</b> : <code>${username}</code>\n` +
        `📦 <b>Tipe Panel</b> : ${order.panel_type.toUpperCase()}\n` +
        `💰 <b>Harga</b> : Rp ${order.amount.toLocaleString('id-ID')}\n` +
        `🆔 <b>Server ID</b> : <code>${panelResult.serverId}</code>\n` +
        `🏷️ <b>Nama Server</b> : ${panelResult.name}`;
      try {
        await fetch(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.OWNER_ID,
            text: ownerMsg,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[{ text: '🛒 Beli Panel', url: config.URL }]] }
          })
        });
      } catch (telegramError) {
        console.error('Telegram notification failed:', telegramError);
      }
    }

    // Ambil data order terbaru setelah panel dibuat
    const updatedOrder = await findOrderById(order_id);
    const panel = updatedOrder.panel_data;
    const user = updatedOrder.user_data;

    const callbackData = {
      status: 'paid',
      order_id: order_id,
      error: null,
      panel: {
        name: panel.name,
        ram: panel.ram,
        disk: panel.disk,
        cpu: panel.cpu,
        panelUrl: panel.panelUrl
      },
      user: {
        username: user.username,
        password: user.password,
        email: user.email
      }
    };
    const html = renderHTML('payment-callback.html', {
      SITE_NAME: SITE_NAME,
      callbackData: JSON.stringify(callbackData)
    });
    res.send(html);
  } catch (error) {
    console.error('Callback error:', error);
    const callbackData = {
      status: 'error',
      order_id: order_id,
      error: 'Terjadi kesalahan. Hubungi admin. Order ID: ' + order_id,
      panel: null,
      user: null
    };
    const html = renderHTML('payment-callback.html', {
      SITE_NAME: SITE_NAME,
      callbackData: JSON.stringify(callbackData)
    });
    res.status(500).send(html);
  }
});

// ==========================================================================
// API REFUND ORDER
// ==========================================================================
app.post('/api/refund-order', isAuthenticated, async (req, res) => {
try {
const { order_id, dana_number, dana_name, reason } = req.body;
if (!order_id) return res.status(400).json({ success: false, message: 'Order ID diperlukan' });
const order = await findOrderById(order_id);
if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
if (order.status === 'pending') {
const cancelResult = await cancelPakasirTransaction(order_id, order.amount);
if (!cancelResult.success) return res.status(500).json({ success: false, message: 'Gagal membatalkan order: ' + (cancelResult.error || 'unknown error') });
const activeOrders = await getOrders();
const newActive = activeOrders.filter(o => o.order_id !== order_id);
await saveOrders(newActive);
const cancelledOrders = await getCancelledOrders();
cancelledOrders.push({ ...order, status: 'cancel', cancelled_at: new Date().toISOString() });
await saveCancelledOrders(cancelledOrders);
return res.json({ success: true, message: 'Order berhasil dibatalkan' });
}
if (order.status === 'paid' || order.status === 'completed') {
const isAdminUser = req.user.email === config.ADMIN_EMAIL;
const paymentTime = new Date(order.created_at).getTime();
const now = Date.now();
const elapsedMinutes = (now - paymentTime) / (1000 * 60);
if (!isAdminUser && elapsedMinutes > 20) return res.status(400).json({ success: false, message: 'Refund hanya dapat diajukan dalam 20 menit setelah pembayaran berhasil' });
const existingRequest = await findRefundRequest(order_id);
if (existingRequest) return res.status(400).json({ success: false, message: 'Permintaan refund sudah pernah diajukan dan sedang diproses' });
if (!dana_number || !dana_name) return res.status(400).json({ success: false, message: 'Nomor Dana dan Nama Akun Dana harus diisi' });
await addRefundRequest(order, { dana_number, dana_name, reason: reason || '' });
return res.json({ success: true, message: 'Permintaan refund telah dikirim. Menunggu persetujuan admin.' });
}
res.status(400).json({ success: false, message: 'Status order tidak valid untuk refund' });
} catch (error) {
console.error('Refund order error:', error);
await sendTelegramError(error, { route: '/api/refund-order', body: req.body });
res.status(500).json({ success: false, message: error.message || 'Internal server error' });
}
});

  // ==========================================================================
  // API APPROVE REFUND (ADMIN)
  // ==========================================================================
  app.post('/api/approve-refund', isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { order_id } = req.body;
      if (!order_id) return res.status(400).json({ success: false, message: 'Order ID diperlukan' });
      const refundRequest = await findRefundRequest(order_id);
      if (!refundRequest) return res.status(404).json({ success: false, message: 'Permintaan refund tidak ditemukan' });
      const order = await findOrderById(order_id);
      if (!order) {
        await removeRefundRequest(order_id);
        return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
      }
      let serverDeleted = true;
      if (order.panel_created && order.panel_data && order.panel_data.serverId) {
        const deleteResult = await deletePterodactylServer(order.panel_data.serverId);
        if (!deleteResult.success) serverDeleted = false;
      }
      const activeOrders = await getOrders();
      const newActive = activeOrders.filter(o => o.order_id !== order_id);
      await saveOrders(newActive);
      const cancelledOrders = await getCancelledOrders();
      cancelledOrders.push({ ...order, status: 'refunded', cancelled_at: new Date().toISOString(), refunded_at: new Date().toISOString(), server_deleted: serverDeleted, refund_data: { dana_number: refundRequest.dana_number, dana_name: refundRequest.dana_name, reason: refundRequest.reason } });
      await saveCancelledOrders(cancelledOrders);
      const user = await findUserByEmail(order.email);
      if (user) {
        const updatedPurchased = (user.purchasedPanels || []).filter(p => p.order_id !== order_id);
        await updateUser(user.id, { purchasedPanels: updatedPurchased });
      }
      await removeRefundRequest(order_id);
      res.json({ success: true, message: serverDeleted ? 'Refund berhasil diproses, server telah dihapus' : 'Refund berhasil diproses, namun server gagal dihapus. Silakan cek manual.' });
    } catch (error) {
      console.error('Approve refund error:', error);
      await sendTelegramError(error, { route: '/api/approve-refund', body: req.body });
      res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
  });

  // ==========================================================================
  // API CANCEL ORDER (ADMIN)
  // ==========================================================================
  app.post('/api/cancel-order', isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { order_id } = req.body;
      if (!order_id) return res.status(400).json({ success: false, message: 'Order ID diperlukan' });
      const order = await findOrderById(order_id);
      if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
      if (order.status !== 'pending') return res.status(400).json({ success: false, message: 'Hanya order pending yang dapat dibatalkan (gunakan refund untuk paid)' });
      const cancelResult = await cancelPakasirTransaction(order_id, order.amount);
      if (!cancelResult.success) return res.status(500).json({ success: false, message: 'Gagal membatalkan order: ' + (cancelResult.error || 'unknown error') });
      const activeOrders = await getOrders();
      const newActive = activeOrders.filter(o => o.order_id !== order_id);
      await saveOrders(newActive);
      const cancelledOrders = await getCancelledOrders();
      cancelledOrders.push({ ...order, status: 'cancel', cancelled_at: new Date().toISOString() });
      await saveCancelledOrders(cancelledOrders);
      res.json({ success: true, message: 'Order berhasil dibatalkan dan dana dikembalikan' });
    } catch (error) {
      console.error('Cancel order error:', error);
      await sendTelegramError(error, { route: '/api/cancel-order', body: req.body });
      res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
  });

  // ==========================================================================
  // API STATUS
  // ==========================================================================
  app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', version: config.VERSI_WEB, developer: config.DEVELOPER, uptime: process.uptime(), timestamp: Date.now() });
  });

  // ==========================================================================
  // ROUTE AVATAR (DIPERBAIKI)
  // ==========================================================================
  app.get('/api/avatar/:userId', isAuthenticated, async (req, res) => {
    const { userId } = req.params;
    const currentUser = req.user;
    if (currentUser.id !== parseInt(userId) && currentUser.email !== config.ADMIN_EMAIL) {
      return res.status(403).send('Forbidden');
    }
    const user = await findUserById(parseInt(userId));
    if (!user || !user.photo) {
      const email = user ? user.email : '';
      return res.redirect(getGravatarUrl(email, 200));
    }
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path: user.photo, ref: GITHUB_BRANCH });
      const fileBuffer = Buffer.from(data.content, 'base64');
      const ext = user.photo.split('.').pop().toLowerCase();
      let contentType = 'image/jpeg';
      if (ext === 'png') contentType = 'image/png';
      else if (ext === 'gif') contentType = 'image/gif';
      else if (ext === 'webp') contentType = 'image/webp';
      else if (ext === 'bmp') contentType = 'image/bmp';
      res.set('Content-Type', contentType);
      res.send(fileBuffer);
    } catch (err) {
      console.error('Avatar fetch error:', err);
      res.redirect(getGravatarUrl(user.email, 200));
    }
  });

app.get('/login', (req, res) => {
if (req.isAuthenticated()) return res.redirect('/profile');
const error = req.flash('error')[0] || '';
const html = renderHTML('login.html', {
SITE_NAME: SITE_NAME,
FAVICON: config.FAVICON,
URL: config.URL,
csrfToken: req.csrfToken(),
errorMessage: error ? escapeHTML(error) : ''
});
res.send(html);
});

app.post('/login', (req, res, next) => {
passport.authenticate('local', (err, user, info) => {
if (err) {
req.flash('error', 'Terjadi kesalahan sistem');
return res.redirect('/login');
}
if (!user) {
req.flash('error', info.message || 'Email atau password salah');
return res.redirect('/login');
}
req.logIn(user, (err) => {
if (err) {
req.flash('error', 'Gagal membuat sesi login');
return res.redirect('/login');
}
return res.redirect('/profile');
});
})(req, res, next);
});

    // ROUTE REGISTER (GET) - menggunakan renderHTML
    app.get('/register', (req, res) => {
        if (req.isAuthenticated()) return res.redirect('/profile');
        const error = req.flash('error')[0] || '';
        const rateLimitMessage = req.flash('rateLimit')[0] || '';
        const html = renderHTML('register.html', {
            SITE_NAME: SITE_NAME,
            FAVICON: config.FAVICON,
            URL: config.URL,
            csrfToken: req.csrfToken(),
            errorMessage: escapeHTML(error || rateLimitMessage),
            TURNSTILE_SITE_KEY: config.TURNSTILE_SITE_KEY
        });
        res.send(html);
    });

    app.post('/register', async (req, res) => {
        const clientIp = req.ip || req.connection.remoteAddress;
        if (await isRegisterBlocked(clientIp)) {
            req.flash('error', 'Terlalu banyak percobaan registrasi. Silakan coba lagi setelah 5 menit.');
            return res.redirect('/register');
        }
        const attempt = await registerAttempt(clientIp);
        if (attempt.blocked) {
            req.flash('error', 'Terlalu banyak percobaan registrasi. Silakan coba lagi setelah 5 menit.');
            return res.redirect('/register');
        }
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            req.flash('error', 'Semua field harus diisi');
            return res.redirect('/register');
        }
        if (password.length < 6) {
            req.flash('error', 'Password minimal 6 karakter');
            return res.redirect('/register');
        }
        if (!email.endsWith('@gmail.com')) {
            req.flash('error', 'Email harus menggunakan domain @gmail.com');
            return res.redirect('/register');
        }
        try {
            const existing = await findUserByEmail(email);
            if (existing) {
                req.flash('error', 'Email sudah digunakan');
                return res.redirect('/register');
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            await createUser({ email, password: hashedPassword, name, bio: '', photo: '' });
            await clearRegisterAttempts(clientIp);
            console.log('✅ Registrasi berhasil, menunggu 5 detik sebelum redirect ke login...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            req.flash('success', 'Registrasi berhasil, silakan login');
            res.redirect('/login');
        } catch (err) {
            await sendTelegramError(err, { route: '/register', email });
            req.flash('error', 'Terjadi kesalahan server. Coba lagi nanti.');
            res.redirect('/register');
        }
    });

    app.get('/logout', (req, res) => {
        req.logout((err) => { if (err) console.error(err); res.redirect('/'); });
    });

    // GOOGLE OAUTH ROUTES
    app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
    app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login', failureFlash: true }), (req, res) => { res.redirect('/profile'); });

    // ROUTE PROFILE (GET) - menggunakan renderHTML
    app.get('/profile', isAuthenticated, async (req, res) => {
        const user = req.user;
        const photoUrl = user.photo ? `/api/avatar/${user.id}` : getGravatarUrl(user.email, 200);
        const orders = await getOrders();
        const userOrders = orders.filter(o => o.email === user.email && o.panel_created === true);
        const refundRequests = await getRefundRequests();
        const userRefundRequests = refundRequests.filter(r => r.email === user.email);
        const totalPanels = userOrders.length;
        const totalSpent = userOrders.reduce((sum, o) => sum + o.amount, 0);

        let panelsHtml = '';
        for (const o of userOrders) {
            const panel = o.panel_data;
            const cred = o.user_data;
            if (!panel) continue;
            const statusClass = o.status === 'paid' ? 'status-paid' : 'status-pending';
            const statusText = o.status === 'paid' ? 'Sudah Dibayar' : 'Menunggu Pembayaran';
            const hasRefundRequest = userRefundRequests.some(r => r.order_id === o.order_id);
            const canRequestRefund = o.status === 'paid' && !hasRefundRequest && (Date.now() - new Date(o.created_at).getTime() <= 20 * 60 * 1000);
            const refundButton = canRequestRefund ? `<button class="refund-btn" data-order="${o.order_id}"><i class="fas fa-undo-alt"></i> Ajukan Refund (20 Menit)</button>` : (hasRefundRequest ? `<span class="refund-pending">⏳ Menunggu Persetujuan Admin</span>` : '');
            panelsHtml += `
<div class="panel-card" data-order="${o.order_id}">
    <div class="panel-card-header">
        <span>📦 ${o.panel_type.toUpperCase()} Panel</span>
        <span class="${statusClass}">${statusText}</span>
    </div>
    <div class="panel-card-detail">
        <div><strong>🆔 Order ID:</strong> ${o.order_id}</div>
        <div><strong>🔗 URL Panel:</strong> <a href="${panel.panelUrl}" target="_blank">${panel.panelUrl}</a></div>
        <div><strong>👤 Username:</strong> <code>${cred.username}</code> <button class="copy-btn" data-copy="${cred.username}">Salin</button></div>
        <div><strong>🔑 Password:</strong> <code>${cred.password}</code> <button class="copy-btn" data-copy="${cred.password}">Salin</button></div>
        <div><strong>💾 RAM:</strong> ${panel.ram === 0 ? 'Unlimited' : panel.ram + ' MB'}</div>
        <div><strong>💿 Disk:</strong> ${panel.disk === 0 ? 'Unlimited' : panel.disk + ' MB'}</div>
        <div><strong>⚙️ CPU:</strong> ${panel.cpu === 0 ? 'Unlimited' : panel.cpu + '%'}</div>
    </div>
    <div class="panel-actions">${refundButton}</div>
</div>`;
        }
        if (!panelsHtml) panelsHtml = '<p style="color:#aaa; text-align:center;">Belum ada pembelian panel.</p>';

        const html = renderHTML('profile.html', {
            SITE_NAME: SITE_NAME,
            VERSI_WEB: config.VERSI_WEB,
            DEVELOPER: config.DEVELOPER,
            photoUrl: photoUrl,
            userName: escapeHTML(user.name),
            userId: user.id,
            userBio: escapeHTML(user.bio || 'Belum ada bio.'),
            totalPanels: totalPanels,
            totalSpentFormatted: totalSpent.toLocaleString('id-ID'),
            csrfToken: req.csrfToken(),
            panelsHtml: panelsHtml,
            adminPanelLink: (user.email === config.ADMIN_EMAIL) ? '<a href="/admin"><i class="fas fa-chart-line"></i> Admin Panel</a>' : ''
        });
        res.send(html);
    });

    app.post('/profile', isAuthenticated, upload.single('photo'), async (req, res) => {
        const { name, bio } = req.body;
        if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
        let photoPath = req.user.photo;
        if (req.file) {
            try {
                await deleteUserAvatar(req.user.id);
                photoPath = await uploadAvatarToGitHub(req.user, req.file.buffer, req.file.originalname, req.file.mimetype);
            } catch (err) {
                return res.status(500).json({ error: 'Gagal upload foto: ' + err.message });
            }
        }
        try {
            await updateUser(req.user.id, { name, bio, photo: photoPath });
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Gagal menyimpan profil' });
        }
    });

    // DELETE ACCOUNT (GET) - menggunakan renderHTML
    app.get('/delete-account', isAuthenticated, async (req, res) => {
        const html = renderHTML('delete-account.html', {
            SITE_NAME: SITE_NAME,
            csrfToken: req.csrfToken(),
            userName: escapeHTML(req.user.name)
        });
        res.send(html);
    });

    app.post('/delete-account', isAuthenticated, async (req, res) => {
        const { confirmUsername } = req.body;
        const user = req.user;
        if (confirmUsername !== user.name) {
            req.flash('error', 'Username tidak cocok. Penghapusan akun dibatalkan.');
            return res.redirect('/delete-account');
        }
        try {
            const userId = user.id;
            await deleteUserById(userId);
            req.logout((err) => {
                if (err) console.error(err);
                res.redirect('/?account_deleted=1');
            });
        } catch (error) {
            console.error('Delete account error:', error);
            await sendTelegramError(error, { route: '/delete-account', userId: req.user.id });
            req.flash('error', 'Gagal menghapus akun. Coba lagi nanti.');
            res.redirect('/profile');
        }
    });

// ==========================================================================
// ADMIN DASHBOARD (dengan file HTML terpisah)
// ==========================================================================
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  const users = await getUsers();
  const activeOrders = await getOrders();
  const cancelledOrders = await getCancelledOrders();
  const refundRequests = await getRefundRequests();
  const allOrders = [...activeOrders, ...cancelledOrders];
  const totalUsers = users.filter(u => u.email !== config.ADMIN_EMAIL).length;
  const totalOrders = allOrders.length;
  const totalRevenue = activeOrders.filter(o => o.status === 'paid' || o.status === 'completed')
    .reduce((sum, o) => sum + o.amount, 0);
  const totalLoss = cancelledOrders.filter(o => o.status === 'cancel' || o.status === 'refunded')
    .reduce((sum, o) => sum + o.amount, 0);
  const pendingRefunds = refundRequests.length;
  const sortedOrders = [...allOrders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Siapkan data user untuk tabel
  const userData = [];
  for (const user of users) {
    if (user.email === config.ADMIN_EMAIL) continue;
    const userOrders = allOrders.filter(o => o.email === user.email);
    const purchasedCount = userOrders.filter(o => o.panel_created === true && o.status === 'paid').length;
    const pendingCount = userOrders.filter(o => o.status === 'pending').length;
    const cancelCount = userOrders.filter(o => o.status === 'cancel' || o.status === 'refunded').length;
    userData.push({
      id: user.id,
      name: user.name,
      email: user.email,
      joined: new Date(user.createdAt).toLocaleDateString('id-ID'),
      photo: user.photo ? `/api/avatar/${user.id}` : getGravatarUrl(user.email, 50),
      bio: user.bio || 'Tidak ada bio',
      purchasedCount,
      pendingCount,
      cancelCount
    });
  }
  userData.sort((a, b) => new Date(b.joined) - new Date(a.joined));

  // Siapkan data refund requests
  const refundsData = refundRequests.map(r => ({
    order_id: r.order_id,
    email: r.email,
    panel_type: r.panel_type,
    amount: r.amount,
    requested_at: r.requested_at
  }));

  // Siapkan data orders (hanya 100 terbaru)
  const ordersData = sortedOrders.slice(0, 100).map(o => ({
    order_id: o.order_id,
    email: o.email,
    panel_type: o.panel_type,
    amount: o.amount,
    status: o.status,
    created_at: o.created_at
  }));

  // Kumpulkan semua data dalam satu objek
  const adminData = {
    totalUsers,
    totalOrders,
    totalRevenue,
    totalLoss,
    pendingRefunds,
    refundRequests: refundsData,
    userData,
    sortedOrders: ordersData
  };

  const html = renderHTML('admin.html', {
    SITE_NAME: SITE_NAME,
    DEVELOPER: config.DEVELOPER,
    VERSI_WEB: config.VERSI_WEB,
    adminAvatar: req.user.photo ? `/api/avatar/${req.user.id}` : getGravatarUrl(req.user.email, 50),
    adminName: escapeHTML(req.user.name),
    adminData: JSON.stringify(adminData)
  });
  res.send(html);
});

app.get('/', async (req, res) => {
const isLoggedIn = req.isAuthenticated();
const user = isLoggedIn ? req.user : null;
const photoUrl = user ? (user.photo ? `/api/avatar/${user.id}` : getGravatarUrl(user.email, 40)) : '';
const safeName = user ? escapeHTML(user.name) : 'Pengunjung';
const users = await getUsers();
const orders = await getOrders();
const totalUsers = users.filter(u => u.email !== config.ADMIN_EMAIL).length;
let totalPurchases = 0;
if (user) {
totalPurchases = orders.filter(o => o.email === user.email && o.panel_created === true && o.status === 'paid')
.reduce((sum, o) => sum + o.amount, 0);
}
const whatsappNumber = (config.WHATSAPP || '').replace(/\D/g, '');
const telegramUsername = (config.DEVELOPER || '').replace('@', '');
const panelData = [
{ type: '1gb', ram: '1GB', disk: '1GB', cpu: '40%', price: config.PRICE_1GB || 500 },
{ type: '2gb', ram: '2GB', disk: '2GB', cpu: '60%', price: config.PRICE_2GB || 500 },
{ type: '3gb', ram: '3GB', disk: '3GB', cpu: '80%', price: config.PRICE_3GB || 500 },
{ type: '4gb', ram: '4GB', disk: '4GB', cpu: '100%', price: config.PRICE_4GB || 500 },
{ type: '5gb', ram: '5GB', disk: '5GB', cpu: '120%', price: config.PRICE_5GB || 500 },
{ type: '6gb', ram: '6GB', disk: '6GB', cpu: '140%', price: config.PRICE_6GB || 500 },
{ type: '7gb', ram: '7GB', disk: '7GB', cpu: '160%', price: config.PRICE_7GB || 500 },
{ type: '8gb', ram: '8GB', disk: '8GB', cpu: '180%', price: config.PRICE_8GB || 500 },
{ type: '9gb', ram: '9GB', disk: '9GB', cpu: '200%', price: config.PRICE_9GB || 500 },
{ type: '10gb', ram: '10GB', disk: '10GB', cpu: '220%', price: config.PRICE_10GB || 500 },
{ type: 'unli', ram: 'Unlimited', disk: 'Unlimited', cpu: 'Unlimited', price: config.PRICE_UNLI || 500 }
];
const html = renderHTML('index.html', {
SITE_NAME: SITE_NAME,
VERSI_WEB: config.VERSI_WEB,
DEVELOPER: config.DEVELOPER,
FAVICON: config.FAVICON,
URL: config.URL,
GOOGLE_VERIF: config.GOOGLE_VERIF || '',
whatsappNumber: whatsappNumber,
telegramUsername: telegramUsername,
totalUsers: totalUsers,
isLoggedIn: isLoggedIn,
photoUrl: photoUrl,
safeName: safeName,
totalPurchasesFormatted: totalPurchases.toLocaleString('id-ID'),
panelDataJSON: JSON.stringify(panelData)
});
res.send(html);
});

app.use((req, res) => {
const html = renderHTML('404.html', { SITE_NAME: SITE_NAME });
res.status(404).send(html);
});
}

// ============================================================================
// AUTO CANCEL EXPIRED ORDERS
// ============================================================================
async function autoCancelExpiredOrders() {
try {
const orders = await getOrders();
const now = Date.now();
const toCancel = orders.filter(o => o.status === 'pending' && (now - new Date(o.created_at).getTime() > 120000));
if (toCancel.length) {
const newActive = orders.filter(o => !toCancel.some(c => c.order_id === o.order_id));
await saveOrders(newActive);
const cancelled = await getCancelledOrders();
toCancel.forEach(order => { cancelled.push({ ...order, status: 'cancel', cancelled_at: new Date().toISOString() }); });
await saveCancelledOrders(cancelled);
}
} catch (err) { console.error('Auto cancel error:', err); }
}
setInterval(autoCancelExpiredOrders, 30000);

// ============================================================================
// INISIALISASI GITHUB DARI URL
// ============================================================================
async function initGithub() {
    const tokenConfig = config.GITHUB_TOKEN;
    if (!tokenConfig) throw new Error('GITHUB_TOKEN tidak dikonfigurasi.');
    if (tokenConfig.startsWith('http://') || tokenConfig.startsWith('https://')) {
        const response = await fetch(tokenConfig);
        const data = await response.json();
        GITHUB_TOKEN = data.github_token;
        GITHUB_REPO = data.github_repo;
        GITHUB_BRANCH = data.github_branch || 'main';
        GITHUB_PATH = data.github_path || 'data';
        if (data.google_client_id) config.GOOGLE_CLIENT_ID = data.google_client_id;
        if (data.google_client_secret) config.GOOGLE_CLIENT_SECRET = data.google_client_secret;
        if (!GITHUB_TOKEN || !GITHUB_REPO) throw new Error('Token atau repo tidak ditemukan dalam response JSON');
    } else {
        throw new Error('GITHUB_TOKEN harus berupa URL JSON.');
    }
    octokit = new Octokit({ auth: GITHUB_TOKEN });
    [owner, repo] = GITHUB_REPO.split('/');
}

// ============================================================================
// START SERVER
// ============================================================================
async function startServer() {
    try {
        await initGithub();
        sessionStore = new GitHubSessionStore(octokit, owner, repo, GITHUB_BRANCH, `${GITHUB_PATH}/sessions`);
        app.use(session({
            secret: config.SESSION_SECRET || 'novabot-super-secret-2026',
            store: sessionStore,
            resave: false,
            saveUninitialized: false,
            rolling: true,
            cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
        }));
        app.use((req, res, next) => { if (req.session && req.session.touch) req.session.touch(); next(); });
        app.use(passport.initialize());
        app.use(passport.session());
        app.use(flash());
        const csrfProtection = csrf({ cookie: true });
        app.use((req, res, next) => {
            if (req.method === 'POST' && (req.path === '/login' || req.path === '/register' || req.path === '/profile' || req.path === '/delete-account')) {
                return csrfProtection(req, res, next);
            }
            if (req.path.startsWith('/api/')) return next();
            return csrfProtection(req, res, next);
        });
        if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
            passport.use(new GoogleStrategy({
                clientID: config.GOOGLE_CLIENT_ID,
                clientSecret: config.GOOGLE_CLIENT_SECRET,
                callbackURL: `${config.URL}/auth/google/callback`,
                passReqToCallback: true
            }, async (req, accessToken, refreshToken, profile, done) => {
                try {
                    const email = profile._json.email;
                    let user = await findUserByEmail(email);
                    if (!user) {
                        const newUser = { email, name: profile.displayName || email.split('@')[0], password: null, bio: '', photo: '', googleId: profile.id, createdAt: new Date().toISOString(), purchasedPanels: [], pterodactylUserId: null };
                        user = await createUser(newUser);
                    } else if (!user.googleId) {
                        user.googleId = profile.id;
                        await updateUser(user.id, { googleId: profile.id });
                    }
                    return done(null, user);
                } catch (err) { return done(err, null); }
            }));
        }
        setupRoutes(app);
    app.listen(PORT, HOST, () => {
      console.log(` \x1b[1m\x1b[34m         ⢀⣷⡀\x1b[0m
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀ ⣴⠆⠀⠹⣿⣿⣿⠇\x1b[0m  ⣶⣄
\x1b[1m\x1b[34m⠀⠀⠀ ⣴⣿⠋⠀⠀⠀⢹⣿⣟\x1b[0m    ⣿⣷ \x1b[31m
\x1b[1m\x1b[34m⠀ ⣴⣿⣿⠃⠀⠀⠀⠀⣿⣿⣿\x1b[0m⠀⠀⠀⠀ ⢿⣿⣧⡀\x1b[31m
\x1b[1m\x1b[34m ⣿⣿⣿⣇⠀⠀⠀⠀⠀⣿⣿\x1b[0m⣿⠀⠀⠀⠀⠀⣨⣿⣿⣿⠆\x1b[31m
\x1b[1m\x1b[34m⠀ ⠻⣿⣿⣿⣦⡀⠀⠀⣿\x1b[0m⣿⣿⠀⠀⠀⣠⣾⣿⣿⠟⠁\x1b[31m⠀
\x1b[1m\x1b[34m⠀⠀⠀ ⠻⣿⣿⣿⣦⡀\x1b[0m⣿⣿⣿⢀⣴⣾⣿⣿⠟⠁\x1b[31m⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀⠀⠻⢿⣿\x1b[0m⣿⣿⣿⣿⣿⣿⣿⠟⠁\x1b[31m⠀⠀⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀⠀⠀ ⠛\x1b[0m⣿⣿⣿⣿⣿⠟⠁\x1b[31m⠀⠀⠀⠀⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀⠀⠀⣠⣾⣿\x1b[0m⣿⣿⣿⣿⣷⣄\x1b[31m⠀⠀⠀⠀⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀⣠⣼⣿⣿⣿⢿\x1b[0m⣿⣿⣿⣿⣿⣷⣄\x1b[31m⠀⠀⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⣠⣾⣿⣿⡿⠛⠁⣿⣿⡏\x1b[0m⠀⠙⢿⣿⣿⣷⣄\x1b[31m⠀⠀⠀
\x1b[1m\x1b[34m⠀ ⣾⣿⣿⡿⠋⠀⠀⠀⣿⣿⣿\x1b[0m⠀⠀⠀⠙⢿⣿⣿⣷⣄\x1b[31m⠀
\x1b[1m\x1b[34m ⢿⣿⣿⣿⡀⠀⠀⠀⠀⣿⣿⣿\x1b[0m⠀⠀⠀⠀ ⣽⣿⣿⡿⠃\x1b[31m
\x1b[1m\x1b[34m⠀⠀⠙⢿⣿⣿⣦⡀⠀⠀⣿⣿\x1b[0m⣿⠀⠀ ⣴⣿⣿⡿⠋⠀\x1b[31m⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠙⢿⣿⣿⣦⣄⣿\x1b[0m⣿⣿ ⣴⣿⣿⡿⠋⠀\x1b[31m⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿⣾⣿⣿\x1b[0m⣿⣿⡿⠟⠀\x1b[31m⠀⠀⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿\x1b[0m⣿⣿⠟⠀\x1b[31m⠀⠀⠀⠀⠀⠀⠀
\x1b[1m\x1b[34m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢛⡿⡛⠁\x1b[31m
\x1b[1m\x1b[33m   N O V A N E T   ${config.VERSI_WEB}\x1b[0m
\x1b[1m\x1b[32m─────────────────────────────────────────────────────\x1b[0m
🌐 Server: http://${HOST}:${PORT}
📦 subdo: ${config.URL}
?? Developer: ${config.DEVELOPER}
✅ Server ready! Data tersimpan di GitHub: ${GITHUB_REPO}/${GITHUB_PATH}
`);
    });
  } catch (err) {
    console.error('Gagal memulai server:', err);
    await sendTelegramError(err, { fungsi: 'startServer' });
    process.exit(1);
  }
}

startServer();