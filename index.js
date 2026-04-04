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

const app = express();
const SITE_NAME = config.SITE_NAME || 'novanet';
const PORT = config.PORT || 8080;
const HOST = config.HOST || '0.0.0.0';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const JWT_SECRET = config.JWT_SECRET || config.SESSION_SECRET || 'novabot-jwt-secret-2026';

let GITHUB_TOKEN = null;
let GITHUB_REPO = null;
let GITHUB_BRANCH = 'main';
let GITHUB_PATH = 'data';
let octokit = null;
let owner, repo;
const sessionCache = new Map();

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
  // PAYMENT CALLBACK (HTML LENGKAP)
  // ==========================================================================
  app.get('/payment-callback', async (req, res) => {
    const { order_id, amount } = req.query;
    if (!order_id) return res.redirect('/?error=missing_order');
    const order = await findOrderById(order_id);
    if (!order) return res.redirect('/?error=order_not_found');
    try {
      const paymentStatus = await checkPaymentStatus(order_id, amount || order.amount);
      if (paymentStatus.status !== 'paid' && paymentStatus.status !== 'completed') {
        return res.send(`
<!DOCTYPE html>
<html>
<head><title>Menunggu Pembayaran</title><meta charset="UTF-8"></head>
<body style="background:#02040a; color:#fff; font-family:monospace; text-align:center; padding:50px;">
<h2>⏳ Menunggu Konfirmasi Pembayaran</h2>
<p>Status: ${paymentStatus.status}</p>
<p>Order ID: ${order_id}</p>
<p>Silakan tunggu beberapa saat, atau cek kembali nanti.</p>
<a href="/" style="color:#3a6df0;">Kembali ke Beranda</a>
<script>setTimeout(() => window.location.reload(), 5000);</script>
</body>
</html>
`);
      }
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
          if (user && user.pterodactylUserId !== pterodactylUserId) await updateUser(user.id, { pterodactylUserId });
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
        } catch (telegramError) { console.error('Telegram notification failed:', telegramError); }
      }
      const updatedOrder = await findOrderById(order_id);
      const panel = updatedOrder.panel_data;
      const user = updatedOrder.user_data;
      res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=0.70, user-scalable=yes">
<title>Pembayaran Berhasil - ${SITE_NAME} Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
background:radial-gradient(circle at 20% 30%, #0a0f1a, #03050a);
color:#fff;
font-family:'Rajdhani',sans-serif;
min-height:100vh;
display:flex;
justify-content:center;
align-items:center;
padding:20px;
position:relative;
}
body::before{
content:'';
position:fixed;
top:0;
left:0;
width:100%;
height:100%;
background:url('https://files.catbox.moe/1sr3hx.jpg') no-repeat center center fixed;
background-size:cover;
opacity:0.2;
z-index:-2;
}
body::after{
content:'';
position:fixed;
top:0;
left:0;
width:100%;
height:100%;
background:rgba(0,0,0,0.65);
z-index:-1;
}
.container{
max-width:650px;
width:100%;
background:rgba(15,25,45,0.6);
backdrop-filter:blur(12px);
border-radius:32px;
padding:35px;
border:1px solid rgba(91,140,255,0.4);
box-shadow:0 25px 45px rgba(0,0,0,0.5),0 0 30px rgba(91,140,255,0.2);
animation:fadeInUp 0.5s ease;
}
@keyframes fadeInUp{
from{opacity:0;transform:translateY(30px)}
to{opacity:1;transform:translateY(0)}
}
h1{
font-family:'Orbitron';
background:linear-gradient(135deg,#fff,#5b8cff);
-webkit-background-clip:text;
background-clip:text;
color:transparent;
margin-bottom:15px;
font-size:32px;
text-align:center;
}
.success-icon{
text-align:center;
font-size:70px;
margin-bottom:10px;
animation:pulse 1.5s infinite;
}
@keyframes pulse{
0%,100%{transform:scale(1);opacity:1}
50%{transform:scale(1.05);opacity:0.8}
}
.panel-card{
background:rgba(0,0,0,0.5);
border-radius:24px;
padding:20px;
margin:25px 0;
backdrop-filter:blur(4px);
border:1px solid rgba(91,140,255,0.3);
}
.detail-row{
display:flex;
justify-content:space-between;
align-items:center;
padding:12px 0;
border-bottom:1px solid rgba(255,255,255,0.1);
}
.detail-row:last-child{border-bottom:none}
.detail-label{
color:#8a9bb0;
font-size:14px;
font-weight:600;
}
.detail-value{
font-family:'JetBrains Mono',monospace;
font-size:14px;
word-break:break-word;
text-align:right;
display:flex;
align-items:center;
gap:8px;
}
.copy-btn{
background:#2a3a60;
border:none;
color:#fff;
padding:4px 12px;
border-radius:30px;
cursor:pointer;
font-size:11px;
transition:0.2s;
}
.copy-btn:hover{
background:#5b8cff;
color:#000;
transform:scale(1.02);
}
.btn-group{
display:flex;
gap:15px;
justify-content:center;
margin-top:25px;
flex-wrap:wrap;
}
.btn{
display:inline-flex;
align-items:center;
gap:8px;
background:linear-gradient(90deg,#1e3c72,#2a5298);
color:#fff;
padding:12px 25px;
border-radius:50px;
text-decoration:none;
font-weight:bold;
transition:0.2s;
}
.btn:hover{
transform:scale(1.02);
box-shadow:0 0 20px rgba(91,140,255,0.5);
}
.refund-btn{
background:linear-gradient(90deg,#d32f2f,#f44336);
}
.refund-btn:hover{
box-shadow:0 0 20px #f44336;
}
.back-link{
display:block;
text-align:center;
margin-top:20px;
color:#8a9bb0;
text-decoration:none;
}
.back-link:hover{color:#5b8cff}
.modal{
display:none;
position:fixed;
top:0;
left:0;
width:100%;
height:100%;
background:rgba(0,0,0,0.85);
backdrop-filter:blur(8px);
z-index:2000;
align-items:center;
justify-content:center;
}
.modal-content{
background:#0b0f19;
padding:30px;
border-radius:28px;
max-width:450px;
width:90%;
text-align:center;
border:2px solid #5b8cff;
box-shadow:0 0 40px rgba(91,140,255,0.4);
animation:fadeInUp 0.3s;
}
.modal h2{
font-family:'Orbitron';
color:#5b8cff;
margin-bottom:20px;
font-size:1.5rem;
}
.modal-input-group{
margin-bottom:20px;
text-align:left;
}
.modal-input-group label{
display:block;
margin-bottom:6px;
color:#8a9bb0;
font-size:13px;
}
.modal-input-group input,.modal-input-group textarea{
width:100%;
padding:10px 15px;
border-radius:30px;
border:1px solid #1f2a40;
background:#1a1f30;
color:#fff;
font-size:14px;
}
.modal-input-group textarea{
min-height:80px;
resize:vertical;
}
.warning-text{
color:#ffaa00;
font-size:12px;
margin-top:-8px;
margin-bottom:15px;
}
.modal-buttons{
display:flex;
gap:12px;
margin-top:20px;
}
.modal-btn{
flex:1;
padding:12px;
border-radius:40px;
border:none;
font-weight:bold;
cursor:pointer;
transition:0.2s;
}
.modal-btn.cancel{
background:#2a3a60;
color:#fff;
}
.modal-btn.confirm{
background:linear-gradient(90deg,#1e3c72,#2a5298);
color:#fff;
}
.toast{
position:fixed;
bottom:90px;
left:50%;
transform:translateX(-50%) translateY(20px);
background:#2a3a60;
border-radius:40px;
padding:8px 18px;
font-family:'JetBrains Mono',monospace;
font-size:12px;
color:#fff;
z-index:3000;
opacity:0;
transition:all 0.3s;
pointer-events:none;
}
.toast.show{
opacity:1;
transform:translateX(-50%) translateY(0);
}
@media(max-width:550px){
.container{padding:20px}
h1{font-size:24px}
.detail-row{flex-direction:column;align-items:flex-start;gap:5px}
.detail-value{text-align:left}
}
</style>
</head>
<body>
<div class="container">
<div class="success-icon">✅</div>
<h1>Pembayaran Berhasil!</h1>
<p style="text-align:center;color:#a0b0c0">Panel server Anda telah dibuat dan siap digunakan.</p>
<div class="panel-card">
<div class="detail-row"><span class="detail-label">👤 Username</span><div class="detail-value"><code>${user.username}</code><button class="copy-btn" data-copy="${user.username}">Salin</button></div></div>
<div class="detail-row"><span class="detail-label">🔑 Password</span><div class="detail-value"><code>${user.password}</code><button class="copy-btn" data-copy="${user.password}">Salin</button></div></div>
<div class="detail-row"><span class="detail-label">📧 Email</span><div class="detail-value"><code>${user.email}</code></div></div>
<div class="detail-row"><span class="detail-label">📦 Server</span><div class="detail-value">${panel.name}</div></div>
<div class="detail-row"><span class="detail-label">💾 RAM</span><div class="detail-value">${panel.ram === 0 ? 'Unlimited' : panel.ram + ' MB'}</div></div>
<div class="detail-row"><span class="detail-label">💿 Disk</span><div class="detail-value">${panel.disk === 0 ? 'Unlimited' : panel.disk + ' MB'}</div></div>
<div class="detail-row"><span class="detail-label">⚙️ CPU</span><div class="detail-value">${panel.cpu === 0 ? 'Unlimited' : panel.cpu + '%'}</div></div>
</div>
<div class="btn-group">
<a href="${panel.panelUrl}" class="btn" target="_blank"><i class="fas fa-external-link-alt"></i> Buka Panel</a>
<button class="btn refund-btn" onclick="openRefundModal('${order_id}')"><i class="fas fa-undo-alt"></i> Minta Refund (20 Menit)</button>
</div>
<a href="/" class="back-link">← Kembali ke Beranda</a>
</div>
<div id="refundModal" class="modal"><div class="modal-content"><h2><i class="fas fa-undo-alt"></i> Form Pengajuan Refund</h2><p>Silakan isi data berikut untuk pemrosesan refund.</p><div class="modal-input-group"><label>Nomor Dana</label><input type="text" id="danaNumber" placeholder="Contoh: 081234567890" required></div><div class="modal-input-group"><label>Nama Akun Dana</label><input type="text" id="danaName" placeholder="Nama sesuai rekening Dana" required></div><div class="modal-input-group"><label>Alasan Refund (Opsional)</label><textarea id="refundReason" placeholder="Tulis alasan Anda..."></textarea></div><div class="warning-text">⚠️ Admin tidak bertanggung jawab jika data yang dimasukkan salah. Pastikan data sesuai dengan akun Dana Anda.</div><div class="modal-buttons"><button class="modal-btn cancel" onclick="closeRefundModal()">Batal</button><button class="modal-btn confirm" id="submitRefundBtn">Ajukan Refund</button></div></div></div>
<div id="toast" class="toast">✅ Teks disalin!</div>
<script>
let currentOrderId = null;
function openRefundModal(orderId){currentOrderId=orderId;document.getElementById('danaNumber').value='';document.getElementById('danaName').value='';document.getElementById('refundReason').value='';document.getElementById('refundModal').style.display='flex';}
function closeRefundModal(){document.getElementById('refundModal').style.display='none';currentOrderId=null;}
document.getElementById('submitRefundBtn').addEventListener('click',async function(){const danaNumber=document.getElementById('danaNumber').value.trim();const danaName=document.getElementById('danaName').value.trim();const reason=document.getElementById('refundReason').value.trim();if(!danaNumber||!danaName){alert('Nomor Dana dan Nama Akun Dana harus diisi!');return;}if(!confirm('Apakah Anda yakin ingin mengajukan refund?\\n\\nNomor Dana: '+danaNumber+'\\nNama Akun: '+danaName+'\\nRefund hanya dapat diajukan dalam 20 menit setelah pembayaran.')) return;const btn=this;const originalText=btn.innerText;btn.innerText='Memproses...';btn.disabled=true;try{const res=await fetch('/api/refund-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:currentOrderId,dana_number:danaNumber,dana_name:danaName,reason:reason})});const data=await res.json();if(data.success){alert('Permintaan refund telah dikirim. Menunggu persetujuan admin.');window.location.href='/';}else{alert('Gagal: '+(data.message||'Unknown error'));closeRefundModal();}}catch(err){console.error(err);alert('Terjadi kesalahan, coba lagi nanti.');closeRefundModal();}finally{btn.innerText=originalText;btn.disabled=false;}});
function showToast(){const toast=document.getElementById('toast');toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1500);}
document.querySelectorAll('.copy-btn').forEach(btn=>{btn.addEventListener('click',()=>{const text=btn.getAttribute('data-copy');navigator.clipboard.writeText(text).then(()=>showToast());});});
</script>
</body>
</html>
`);
    } catch (error) {
      console.error('Callback error:', error);
      res.send(`<html><body><h2>Error</h2><p>Hubungi admin. Order ID: ${order_id}</p><a href="/">Back</a></body></html>`);
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

// ==========================================================================
// ROUTE LOGIN (GET & POST) – LOGO DIPERBESAR, BLUR LEBIH TIPIS
// ==========================================================================
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/profile');
  const error = req.flash('error')[0];
  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=0.70">
<title>Login - ${SITE_NAME} cpanel</title>
<link rel="icon" type="image/jpeg" href="${config.FAVICON}">
<link rel="shortcut icon" href="${config.FAVICON}">
<meta property="og:title" content="Login - ${config.SITE_NAME || 'NovaBot'} Panel">
<meta property="og:description" content="Akses panel ${config.SITE_NAME || 'NovaBot'} dengan akun Anda.">
<meta property="og:image" content="${config.FAVICON}">
<meta property="og:url" content="${config.URL}/login">
<meta property="og:type" content="website">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Rajdhani',sans-serif}
body{background:url('https://files.catbox.moe/e6ickj.jpg') no-repeat center center fixed;background-size:cover;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#fff;position:relative;padding:20px}
body::before{content:'';position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:0}
.back-home{position:absolute;top:20px;left:20px;z-index:2}
.back-home a{display:flex;align-items:center;gap:8px;color:#fff;text-decoration:none;font-size:16px;background:rgba(15,19,32,0.5);backdrop-filter:blur(8px);padding:8px 18px;border-radius:40px;border:1px solid #2a3a60;transition:0.3s}
.back-home a:hover{background:#5b8cff;color:#000;border-color:#5b8cff}
.login-box{
background:rgba(15,19,32,0.5);
backdrop-filter:blur(8px);
border:1px solid #2a3a60;
border-radius:24px;
padding:40px;
width:100%;
max-width:400px;
box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 20px #5b8cff33;
text-align:center;
animation:glow 3s infinite alternate;
position:relative;
z-index:1;
margin:auto
}
@keyframes glow{0%{box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 20px #5b8cff33}100%{box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 40px #5b8cff80}}
.logo-login {
width: 250px;
height: auto;
margin-bottom: 15px;
border-radius: 16px;
transition: transform 0.2s;
display: block;
margin-left: auto;
margin-right: auto;
}
.logo-login:hover {
transform: scale(1.05);
}
h2{font-family:'Orbitron',sans-serif;color:#5b8cff;margin-bottom:20px;font-size:28px;letter-spacing:2px;text-shadow:0 0 10px #5b8cff}
.input-group{margin-bottom:25px;text-align:left}
label{display:block;margin-bottom:8px;color:#8a9bb0;font-size:14px;font-weight:600}
input{width:100%;padding:14px;border-radius:40px;border:1px solid #1f2a40;background:#1a1f30;color:#fff;font-size:15px;transition:0.2s}
input:focus{outline:none;border-color:#5b8cff;box-shadow:0 0 10px #5b8cff}
button{width:100%;padding:14px;background:linear-gradient(45deg,#5b8cff,#3a6df0);border:none;border-radius:40px;color:#000;font-weight:bold;cursor:pointer;margin:15px 0;font-size:16px;transition:0.2s}
button:hover{transform:scale(1.02);box-shadow:0 0 20px #5b8cff}
.error{background:#ff3b30;color:#fff;padding:12px;border-radius:40px;margin-bottom:25px;font-size:14px;text-align:center}
.link{color:#5b8cff;text-decoration:none;font-size:14px}
.footer{color:#5f6b7a;font-size:12px;border-top:1px solid #1f2a40;padding-top:20px;margin-top:20px}
.footer span{color:#00ff88}
.google-btn{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#444;padding:10px 20px;border-radius:40px;text-decoration:none;font-weight:500;border:1px solid #ddd;transition:0.2s;margin-top:10px}
.google-btn:hover{background:#f1f1f1;transform:scale(1.02)}
.google-btn img{width:20px;height:20px}
</style>
</head>
<body>
<div class="back-home"><a href="/"><i class="fas fa-home"></i> Kembali ke Beranda</a></div>
<div class="login-box">
<img src="https://files.catbox.moe/u47x3d.png" alt="Logo ${SITE_NAME}" class="logo-login">
<div class="error" id="errorMessage" style="${error ? '' : 'display:none;'}">${error ? escapeHTML(error) : ''}</div>
<form action="/login" method="POST">
<input type="hidden" name="_csrf" value="${req.csrfToken()}">
<div class="input-group"><label>EMAIL</label><input type="email" name="email" placeholder="email@example.com" required></div>
<div class="input-group"><label>PASSWORD</label><input type="password" name="password" placeholder="••••••••" required></div>
<button type="submit">LOGIN</button>
</form>
<div style="margin:20px 0; text-align:center;">
<a href="/auth/google" class="google-btn">
<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google">
Login dengan Google
</a>
</div>
<p style="margin:15px 0;"><a href="/register" class="link">Belum punya akun? Daftar</a></p>
<div class="footer"><span>AES-256</span> • status: ONLINE • PING 19ms</div>
</div>
<script>
const errorDiv = document.getElementById('errorMessage');
if(errorDiv && errorDiv.innerText.trim() !== '') {
errorDiv.style.display = 'block';
}
</script>
</body>
</html>
`;
  res.send(html);
});

  app.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) { 
        console.error('Login error:', err);
        req.flash('error', 'Terjadi kesalahan sistem');
        return res.redirect('/login');
      }
      if (!user) { 
        req.flash('error', info.message || 'Email atau password salah');
        return res.redirect('/login');
      }
      req.logIn(user, (err) => {
        if (err) { 
          console.error('Login session error:', err);
          req.flash('error', 'Gagal membuat sesi login');
          return res.redirect('/login');
        }
        return res.redirect('/profile');
      });
    })(req, res, next);
  });

// ==========================================================================
// ROUTE REGISTER (GET) – DENGAN LOGO 200px & BLUR 8px
// ==========================================================================
app.get('/register', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/profile');
  const error = req.flash('error')[0];
  const rateLimitMessage = req.flash('rateLimit')[0];
  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=0.70">
<title>Register - ${SITE_NAME} cpanel</title>
<link rel="icon" type="image/jpeg" href="${config.FAVICON}">
<link rel="shortcut icon" href="${config.FAVICON}">
<meta property="og:title" content="Register - ${config.SITE_NAME || 'NovaBot'} Panel">
<meta property="og:description" content="Daftar akun baru untuk mengakses panel ${config.SITE_NAME || 'NovaBot'}.">
<meta property="og:image" content="${config.FAVICON}">
<meta property="og:url" content="${config.URL}/register">
<meta property="og:type" content="website">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback" defer></script>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Rajdhani',sans-serif}
body{background:url('https://files.catbox.moe/e6ickj.jpg') no-repeat center center fixed;background-size:cover;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#fff;position:relative;padding:20px}
body::before{content:'';position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:0} /* overlay lebih terang */
.back-home{position:absolute;top:20px;left:20px;z-index:2}
.back-home a{display:flex;align-items:center;gap:8px;color:#fff;text-decoration:none;font-size:16px;background:rgba(15,19,32,0.5);backdrop-filter:blur(8px);padding:8px 18px;border-radius:40px;border:1px solid #2a3a60;transition:0.3s}
.back-home a:hover{background:#5b8cff;color:#000;border-color:#5b8cff}
.register-box{
background:rgba(15,19,32,0.5);
backdrop-filter:blur(8px);
border:1px solid #2a3a60;
border-radius:24px;
padding:40px;
width:100%;
max-width:400px;
box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 20px #5b8cff33;
text-align:center;
animation:glow 3s infinite alternate;
position:relative;
z-index:1;
margin:auto
}
@keyframes glow{0%{box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 20px #5b8cff33}100%{box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 40px #5b8cff80}}
.logo-register {
width: 250px;
height: auto;
margin-bottom: 15px;
border-radius: 20px;
transition: transform 0.2s;
display: block;
margin-left: auto;
margin-right: auto;
}
.logo-register:hover {
transform: scale(1.05);
}
h2{font-family:'Orbitron',sans-serif;color:#5b8cff;margin-bottom:20px;font-size:28px;letter-spacing:2px;text-shadow:0 0 10px #5b8cff}
.input-group{margin-bottom:20px;text-align:left}
label{display:block;margin-bottom:8px;color:#8a9bb0;font-size:14px;font-weight:600}
input{width:100%;padding:14px;border-radius:40px;border:1px solid #1f2a40;background:#1a1f30;color:#fff;font-size:15px;transition:0.2s}
input:focus{outline:none;border-color:#5b8cff;box-shadow:0 0 10px #5b8cff}
.error-msg{color:#ff3b30;font-size:12px;display:block;margin-top:5px;min-height:18px}
button{width:100%;padding:14px;background:linear-gradient(45deg,#5b8cff,#3a6df0);border:none;border-radius:40px;color:#000;font-weight:bold;cursor:pointer;margin:15px 0;font-size:16px;transition:0.2s}
button:hover{transform:scale(1.02);box-shadow:0 0 20px #5b8cff}
button:disabled{opacity:0.5;cursor:not-allowed}
.error{background:#ff3b30;color:#fff;padding:12px;border-radius:40px;margin-bottom:25px;font-size:14px;text-align:center}
.link{color:#5b8cff;text-decoration:none;font-size:14px}
.footer{color:#5f6b7a;font-size:12px;border-top:1px solid #1f2a40;padding-top:20px;margin-top:20px}
.footer span{color:#00ff88}
.turnstile-container{min-height:0;display:none;justify-content:center;align-items:center;margin:0;opacity:0;transition:opacity 0.3s ease,margin 0.3s ease}
.turnstile-container.show{display:flex;opacity:1;margin:15px 0}
.button-wrapper{transition:margin 0.3s ease}
.button-wrapper.shifted{margin-top:20px}
</style>
</head>
<body>
<div class="back-home"><a href="/"><i class="fas fa-home"></i> Kembali ke Beranda</a></div>
<div class="register-box">
<img src="https://files.catbox.moe/u47x3d.png" alt="Logo ${SITE_NAME}" class="logo-register">
<div class="error" id="errorMessage" style="${error || rateLimitMessage ? '' : 'display:none;'}">${escapeHTML(error || rateLimitMessage)}</div>
<form id="registerForm" action="/register" method="POST">
<input type="hidden" name="_csrf" value="${req.csrfToken()}">
<div class="input-group"><input type="text" name="name" id="regName" placeholder="Nama lengkap" required><span class="error-msg" id="nameError"></span></div>
<div class="input-group"><input type="email" name="email" id="regEmail" placeholder="email@gmail.com"><span class="error-msg" id="emailError"></span></div>
<div class="input-group"><input type="password" name="password" id="regPassword" placeholder="Minimal 6 karakter"><span class="error-msg" id="passwordError"></span></div>
<div id="turnstile-container" class="turnstile-container"></div>
<input type="hidden" name="cf-turnstile-response" id="turnstileToken">
<div class="button-wrapper" id="buttonWrapper">
<button type="button" id="mainBtn" onclick="handleMainClick()" ${rateLimitMessage ? 'disabled' : ''}><i class="fas fa-user-plus"></i> Daftar</button>
</div>
</form>
<p style="margin:15px 0;"><a href="/login" class="link">Sudah punya akun? Login</a></p>
<div class="footer"><span>AES-256</span> • status: ONLINE • PING 19ms</div>
</div>
<script>
window.onloadTurnstileCallback = function () {};
let verifying = false;
function showError(fieldId, message) { document.getElementById(fieldId + 'Error').innerText = message; }
function clearErrors() { showError('name',''); showError('email',''); showError('password',''); }
function validateForm() {
clearErrors(); let isValid = true;
const name = document.getElementById('regName').value.trim();
const email = document.getElementById('regEmail').value.trim();
const password = document.getElementById('regPassword').value.trim();
if (!name) { showError('name','Nama harus diisi'); isValid = false; }
if (!email) { showError('email','Email harus diisi'); isValid = false; }
else if (!/^[a-zA-Z0-9._%+-]+@gmail\\.com$/.test(email)) { showError('email','Email harus menggunakan domain @gmail.com'); isValid = false; }
if (!password) { showError('password','Password harus diisi'); isValid = false; }
else if (password.length < 6) { showError('password','Password minimal 6 karakter'); isValid = false; }
return isValid;
}
function handleMainClick() {
const btn = document.getElementById('mainBtn');
const container = document.getElementById('turnstile-container');
const wrapper = document.getElementById('buttonWrapper');
if (verifying) return;
if (!validateForm()) return;
verifying = true;
wrapper.classList.add('shifted');
btn.disabled = true;
btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memverifikasi...';
container.style.display = 'flex';
setTimeout(() => container.classList.add('show'), 50);
turnstile.render('#turnstile-container', {
sitekey: '${config.TURNSTILE_SITE_KEY}',
execution: 'execute',
appearance: 'execute',
theme: 'dark',
size: 'normal',
callback: function(token) {
document.getElementById('turnstileToken').value = token;
document.getElementById('registerForm').submit();
},
'error-callback': function() {
alert('Verifikasi gagal. Silakan coba lagi.');
wrapper.classList.remove('shifted');
btn.disabled = false;
btn.innerHTML = '<i class="fas fa-user-plus"></i> Daftar';
container.classList.remove('show');
container.style.display = 'none';
verifying = false;
},
'timeout-callback': function() {
alert('Waktu verifikasi habis. Silakan coba lagi.');
wrapper.classList.remove('shifted');
btn.disabled = false;
btn.innerHTML = '<i class="fas fa-user-plus"></i> Daftar';
container.classList.remove('show');
container.style.display = 'none';
verifying = false;
}
});
turnstile.execute();
}
const errorDiv = document.getElementById('errorMessage');
if(errorDiv && errorDiv.innerText.trim() !== '') {
errorDiv.style.display = 'block';
}
</script>
</body>
</html>
  `;
  res.send(html);
});

  // POST REGISTER DENGAN JEDA 5 DETIK
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
      // Proses createUser (termasuk upload foto) - sudah menunggu selesai
      await createUser({ email, password: hashedPassword, name, bio: '', photo: '' });
      await clearRegisterAttempts(clientIp);
      
      // JEDA 5 DETIK SEBELUM REDIRECT KE LOGIN (memberi waktu GitHub sync)
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

  // ==========================================================================
  // GOOGLE OAUTH ROUTES
  // ==========================================================================
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login', failureFlash: true }),
    (req, res) => {
      res.redirect('/profile');
    }
  );

  // ==========================================================================
  // ROUTE PROFILE (GET & POST) - LENGKAP
  // ==========================================================================
  app.get('/profile', isAuthenticated, async (req, res) => {
    const user = req.user;
    const photoUrl = user.photo ? `/api/avatar/${user.id}` : getGravatarUrl(user.email, 200);
    const safeName = escapeHTML(user.name);
    const safeBio = escapeHTML(user.bio || 'Belum ada bio.');
    const orders = await getOrders();
    const userOrders = orders.filter(o => o.email === user.email && o.panel_created === true);
    const refundRequests = await getRefundRequests();
    const userRefundRequests = refundRequests.filter(r => r.email === user.email);
    const totalPanels = userOrders.length;
    const totalSpent = userOrders.reduce((sum, o) => sum + o.amount, 0);
    const panelsHtml = userOrders.map(o => {
      const panel = o.panel_data;
      const cred = o.user_data;
      if (!panel) return '';
      const statusClass = o.status === 'paid' ? 'status-paid' : 'status-pending';
      const statusText = o.status === 'paid' ? 'Sudah Dibayar' : 'Menunggu Pembayaran';
      const hasRefundRequest = userRefundRequests.some(r => r.order_id === o.order_id);
      const canRequestRefund = o.status === 'paid' && !hasRefundRequest && (Date.now() - new Date(o.created_at).getTime() <= 20 * 60 * 1000);
      const refundButton = canRequestRefund ? `<button class="refund-btn" data-order="${o.order_id}"><i class="fas fa-undo-alt"></i> Ajukan Refund (20 Menit)</button>` : (hasRefundRequest ? `<span class="refund-pending">⏳ Menunggu Persetujuan Admin</span>` : '');
      return `
<div class="panel-card" data-order="${o.order_id}">
<div class="panel-card-header">
<span>📦 ${o.panel_type.toUpperCase()} Panel</span>
<span class="${statusClass}">${statusText}</span>
</div>
<div class="panel-card-detail">
<div><strong>🆔 Order ID:</strong> ${o.order_id}</div>
<div><strong>🔗 URL Panel:</strong> <a href="${panel.panelUrl}" target="_blank" rel="noopener">${panel.panelUrl}</a></div>
<div><strong>👤 Username:</strong> <code>${cred.username}</code> <button class="copy-btn" data-copy="${cred.username}">Salin</button></div>
<div><strong>🔑 Password:</strong> <code>${cred.password}</code> <button class="copy-btn" data-copy="${cred.password}">Salin</button></div>
<div><strong>💾 RAM:</strong> ${panel.ram === 0 ? 'Unlimited' : panel.ram + ' MB'}</div>
<div><strong>💿 Disk:</strong> ${panel.disk === 0 ? 'Unlimited' : panel.disk + ' MB'}</div>
<div><strong>⚙️ CPU:</strong> ${panel.cpu === 0 ? 'Unlimited' : panel.cpu + '%'}</div>
</div>
<div class="panel-actions">${refundButton}</div>
</div>
`;
    }).join('');
    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=0.65, user-scalable=yes">
<title>Profil - ${SITE_NAME} Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>
* {
margin: 0;
padding: 0;
box-sizing: border-box;
}
body {
font-family: 'Rajdhani', sans-serif;
background: radial-gradient(circle at 20% 30%, #0a0f1a, #03050a);
color: #fff;
min-height: 100vh;
padding: 20px;
position: relative;
overflow-x: hidden;
}
body::before {
content: '';
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: url('https://files.catbox.moe/96uh8m.png') no-repeat center center fixed;
background-size: cover;
opacity: 0.35;
z-index: -2;
pointer-events: none;
}
body::after {
content: '';
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: rgba(0, 0, 0, 0.55);
z-index: -1;
pointer-events: none;
}
.profile-container {
max-width: 900px;
margin: 0 auto;
background: rgba(15, 25, 45, 0.5);
backdrop-filter: blur(10px);
border-radius: 32px;
border: 1px solid rgba(91, 140, 255, 0.4);
box-shadow: 0 25px 45px rgba(0, 0, 0, 0.5), 0 0 30px rgba(91, 140, 255, 0.2);
padding: 30px;
position: relative;
transition: all 0.3s ease;
}
.profile-header {
display: flex;
justify-content: space-between;
align-items: center;
margin-bottom: 20px;
flex-wrap: wrap;
gap: 15px;
}
.stats-group {
display: flex;
gap: 20px;
background: rgba(0, 0, 0, 0.4);
padding: 8px 20px;
border-radius: 50px;
backdrop-filter: blur(4px);
}
.stat-item {
text-align: center;
}
.stat-label {
font-size: 11px;
color: #8a9bb0;
text-transform: uppercase;
letter-spacing: 1px;
}
.stat-number {
font-size: 20px;
font-family: 'Orbitron';
font-weight: bold;
color: #ffcc00;
}
.menu-btn {
background: rgba(0, 0, 0, 0.5);
border: none;
color: #fff;
font-size: 26px;
cursor: pointer;
transition: 0.2s;
width: 45px;
height: 45px;
border-radius: 50%;
display: flex;
align-items: center;
justify-content: center;
z-index: 20;
position: relative;
}
.menu-btn:hover {
background: rgba(91, 140, 255, 0.4);
transform: scale(1.05);
}
.dropdown-content {
display: none;
position: absolute;
top: 70px;
right: 25px;
background: rgba(10, 15, 25, 0.98);
backdrop-filter: blur(12px);
border: 1px solid #2a3a60;
border-radius: 16px;
min-width: 180px;
box-shadow: 0 12px 28px rgba(0, 0, 0, 0.4);
z-index: 100;
overflow: hidden;
}
.dropdown-content a, .dropdown-content button {
color: #fff;
padding: 12px 18px;
text-decoration: none;
display: flex;
align-items: center;
gap: 10px;
background: none;
border: none;
width: 100%;
text-align: left;
font-size: 14px;
cursor: pointer;
transition: 0.2s;
}
.dropdown-content a:hover, .dropdown-content button:hover {
background: rgba(91, 140, 255, 0.2);
color: #5b8cff;
}
.show {
display: block;
}
.avatar-section {
text-align: center;
margin-bottom: 15px;
}
.avatar {
width: 130px;
height: 130px;
border-radius: 50%;
object-fit: cover;
border: 3px solid #5b8cff;
box-shadow: 0 0 20px rgba(91, 140, 255, 0.5);
transition: transform 0.3s ease;
}
.avatar:hover {
transform: scale(1.02);
}
.user-name {
font-size: 28px;
font-family: 'Orbitron', sans-serif;
background: linear-gradient(135deg, #fff, #5b8cff);
-webkit-background-clip: text;
background-clip: text;
color: transparent;
text-align: center;
margin: 12px 0 8px;
letter-spacing: 1px;
}
.user-id {
font-size: 14px;
color: #8a9bb0;
text-align: center;
margin-bottom: 5px;
font-family: monospace;
}
.user-bio {
font-size: 15px;
color: #ddd;
text-align: center;
margin-bottom: 25px;
max-width: 500px;
margin-left: auto;
margin-right: auto;
word-wrap: break-word;
background: rgba(0, 0, 0, 0.4);
padding: 6px 18px;
border-radius: 40px;
display: inline-block;
width: auto;
}
.edit-form {
display: none;
margin-top: 25px;
border-top: 1px solid rgba(91, 140, 255, 0.3);
padding-top: 25px;
}
.form-group {
margin-bottom: 20px;
}
label {
display: block;
margin-bottom: 8px;
color: #8a9bb0;
font-size: 14px;
font-weight: 600;
}
input, textarea {
width: 100%;
padding: 12px 20px;
border-radius: 40px;
border: 1px solid #1f2a40;
background: rgba(26, 31, 48, 0.9);
color: #fff;
font-size: 14px;
transition: 0.2s;
}
input:focus, textarea:focus {
outline: none;
border-color: #5b8cff;
box-shadow: 0 0 10px rgba(91, 140, 255, 0.3);
}
textarea {
resize: vertical;
min-height: 80px;
border-radius: 20px;
}
button {
background: linear-gradient(45deg, #5b8cff, #3a6df0);
color: #000;
border: none;
padding: 12px 30px;
border-radius: 40px;
font-size: 16px;
font-weight: bold;
cursor: pointer;
transition: 0.2s;
}
button:hover {
transform: scale(1.02);
box-shadow: 0 0 20px rgba(91, 140, 255, 0.5);
}
.section-title {
font-family: 'Orbitron';
font-size: 22px;
color: #5b8cff;
margin: 35px 0 20px;
border-left: 4px solid #5b8cff;
padding-left: 15px;
letter-spacing: 1px;
}
.panel-card {
background: rgba(0, 0, 0, 0.5);
backdrop-filter: blur(4px);
border: 1px solid rgba(91, 140, 255, 0.3);
border-radius: 20px;
margin-bottom: 20px;
padding: 18px;
transition: all 0.3s ease;
}
.panel-card:hover {
border-color: #5b8cff;
transform: translateY(-3px);
box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
}
.panel-card-header {
font-family: 'Orbitron';
font-size: 18px;
color: #ffcc00;
margin-bottom: 12px;
display: flex;
justify-content: space-between;
align-items: center;
flex-wrap: wrap;
gap: 8px;
}
.panel-card-detail {
font-size: 14px;
color: #ddd;
line-height: 1.8;
}
.panel-card-detail a {
color: #5b8cff;
text-decoration: none;
}
.panel-card-detail a:hover {
text-decoration: underline;
}
.copy-btn {
background: #2a3a60;
color: #fff;
border: none;
padding: 2px 12px;
border-radius: 30px;
cursor: pointer;
font-size: 11px;
margin-left: 8px;
transition: 0.2s;
}
.copy-btn:hover {
background: #5b8cff;
color: #000;
}
.panel-actions {
margin-top: 15px;
text-align: right;
}
.refund-btn {
background: #f44336;
color: #fff;
border: none;
padding: 6px 14px;
border-radius: 30px;
cursor: pointer;
font-size: 12px;
transition: 0.2s;
}
.refund-btn:hover {
background: #d32f2f;
transform: scale(1.03);
}
.refund-pending {
background: #ff9800;
color: #000;
padding: 6px 14px;
border-radius: 30px;
font-size: 12px;
display: inline-block;
}
.status-paid {
color: #4caf50;
font-size: 12px;
font-weight: normal;
background: rgba(76, 175, 80, 0.2);
padding: 2px 10px;
border-radius: 20px;
}
.status-pending {
color: #ff9800;
font-size: 12px;
font-weight: normal;
background: rgba(255, 152, 0, 0.2);
padding: 2px 10px;
border-radius: 20px;
}
.footer {
text-align: center;
margin-top: 40px;
color: #5f6b7a;
font-size: 12px;
border-top: 1px solid rgba(91, 140, 255, 0.2);
padding-top: 20px;
}
.spinner {
display: inline-block;
width: 20px;
height: 20px;
border: 2px solid rgba(255, 255, 255, 0.3);
border-top-color: #5b8cff;
border-radius: 50%;
animation: spin 0.8s linear infinite;
margin-right: 8px;
}
@keyframes spin {
to { transform: rotate(360deg); }
}
.loading-text {
display: inline-flex;
align-items: center;
gap: 8px;
}
.modal {
display: none;
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: rgba(0, 0, 0, 0.85);
backdrop-filter: blur(8px);
z-index: 2000;
align-items: center;
justify-content: center;
}
.modal-content {
background: #0b0f19;
padding: 30px;
border-radius: 28px;
max-width: 450px;
width: 90%;
text-align: center;
border: 2px solid #5b8cff;
box-shadow: 0 0 40px rgba(91, 140, 255, 0.4);
animation: fadeInUp 0.3s ease;
}
@keyframes fadeInUp {
from {
opacity: 0;
transform: translateY(30px);
}
to {
opacity: 1;
transform: translateY(0);
}
}
.modal h2 {
font-family: 'Orbitron';
color: #5b8cff;
margin-bottom: 20px;
font-size: 1.5rem;
}
.modal-buttons {
display: flex;
gap: 12px;
margin-top: 20px;
}
.modal-btn {
flex: 1;
padding: 12px;
border-radius: 40px;
border: none;
font-weight: bold;
cursor: pointer;
transition: 0.2s;
}
.modal-btn.cancel {
background: #2a3a60;
color: #fff;
}
.modal-btn.confirm {
background: linear-gradient(90deg, #1e3c72, #2a5298);
color: #fff;
}
.modal-btn:hover {
transform: scale(1.02);
}
.modal-input-group {
margin-bottom: 20px;
text-align: left;
}
.modal-input-group label {
display: block;
margin-bottom: 6px;
color: #8a9bb0;
font-size: 13px;
}
.modal-input-group input, .modal-input-group textarea {
width: 100%;
padding: 10px 15px;
border-radius: 30px;
border: 1px solid #1f2a40;
background: #1a1f30;
color: #fff;
font-size: 14px;
}
.modal-input-group textarea {
min-height: 80px;
resize: vertical;
}
.warning-text {
color: #ffaa00;
font-size: 12px;
margin-top: -8px;
margin-bottom: 15px;
}
#copyNotification {
position: fixed;
top: 30%;
left: 50%;
transform: translate(-50%, -50%);
z-index: 10000;
display: none;
pointer-events: none;
}
#copyNotification img {
max-width: 280px;
width: auto;
border-radius: 16px;
box-shadow: 0 0 30px rgba(91, 140, 255, 0.5);
}
@media (max-width: 640px) {
.profile-container {
padding: 20px;
}
.profile-header {
flex-direction: column;
align-items: stretch;
}
.stats-group {
justify-content: center;
order: 2;
}
.menu-btn {
order: 1;
align-self: flex-end;
}
.avatar {
width: 100px;
height: 100px;
}
.user-name {
font-size: 22px;
}
.section-title {
font-size: 18px;
}
.panel-card-header {
flex-direction: column;
align-items: flex-start;
}
}
</style>
</head>
<body>
<div class="profile-container">
<div class="profile-header">
<div class="stats-group">
<div class="stat-item">
<div class="stat-label">Total Panel</div>
<div class="stat-number">${totalPanels}</div>
</div>
<div class="stat-item">
<div class="stat-label">Total Belanja</div>
<div class="stat-number">Rp ${totalSpent.toLocaleString('id-ID')}</div>
</div>
</div>
<button class="menu-btn" id="menuBtn">☰</button>
</div>
<div class="dropdown-content" id="dropdown">
<a href="/"><i class="fas fa-home"></i> Beranda</a>
<a href="#" id="editProfileBtn"><i class="fas fa-edit"></i> Edit Profil</a>
<a href="/logout"><i class="fas fa-sign-out-alt"></i> Keluar Akun</a>
<a href="/delete-account"><i class="fas fa-trash"></i> Hapus Akun</a>
${user.email === config.ADMIN_EMAIL ? `<a href="/admin"><i class="fas fa-chart-line"></i> Admin Panel</a>` : ''}
</div>
<div class="avatar-section">
<img src="${photoUrl}" class="avatar" id="avatarPreview" alt="Foto Profil">
</div>
<div class="user-name" id="displayName">${safeName}</div>
<div class="user-id">🆔 ID: ${user.id}</div>
<div class="user-bio" id="displayBio">${safeBio}</div>
<div class="edit-form" id="editForm">
<h3 style="font-family:'Orbitron'; color:#5b8cff; margin-bottom:20px;">Edit Profil</h3>
<form id="profileEditForm" enctype="multipart/form-data">
<input type="hidden" name="_csrf" value="${req.csrfToken()}">
<div class="form-group"><label>Nama</label><input type="text" name="name" id="editName" value="${escapeHTML(user.name)}" required></div>
<div class="form-group"><label>Bio</label><textarea name="bio" id="editBio">${escapeHTML(user.bio || '')}</textarea></div>
<div class="form-group"><label>Foto Profil</label><input type="file" name="photo" id="editPhoto" accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/bmp"></div>
<button type="submit" id="submitBtn">Simpan Perubahan</button>
</form>
</div>
<div class="section-title"><i class="fas fa-server"></i> Panel yang Dibeli</div>
<div id="purchasedPanels">
${panelsHtml || '<p style="color:#aaa; text-align:center;">Belum ada pembelian panel.</p>'}
</div>
<div class="footer">
<span>${SITE_NAME} cPanel v${config.VERSI_WEB}</span> • ${config.DEVELOPER}
</div>
</div>
<div id="copyNotification">
<img src="https://files.catbox.moe/guq9ea.gif" alt="Copied">
</div>

<!-- Modal Refund -->
<div id="refundModal" class="modal">
<div class="modal-content">
<h2><i class="fas fa-undo-alt"></i> Form Pengajuan Refund</h2>
<p>Silakan isi data berikut untuk pemrosesan refund.</p>
<div class="modal-input-group">
<label>Nomor Dana</label>
<input type="text" id="danaNumber" placeholder="Contoh: 081234567890" required>
</div>
<div class="modal-input-group">
<label>Nama Akun Dana</label>
<input type="text" id="danaName" placeholder="Nama sesuai rekening Dana" required>
</div>
<div class="modal-input-group">
<label>Alasan Refund (Opsional)</label>
<textarea id="refundReason" placeholder="Tulis alasan Anda..."></textarea>
</div>
<div class="warning-text">⚠️ Admin tidak bertanggung jawab jika data yang dimasukkan salah. Pastikan data sesuai dengan akun Dana Anda.</div>
<div class="modal-buttons">
<button class="modal-btn cancel" onclick="closeRefundModal()">Batal</button>
<button class="modal-btn confirm" id="submitRefundBtn">Ajukan Refund</button>
</div>
</div>
</div>

<script>
const menuBtn = document.getElementById('menuBtn');
const dropdown = document.getElementById('dropdown');
menuBtn.addEventListener('click', (e) => {
e.stopPropagation();
dropdown.classList.toggle('show');
});
window.addEventListener('click', () => {
dropdown.classList.remove('show');
});
document.getElementById('editProfileBtn').addEventListener('click', (e) => {
e.preventDefault();
document.getElementById('editForm').style.display = 'block';
dropdown.classList.remove('show');
});
const profileForm = document.getElementById('profileEditForm');
const originalSubmitText = document.getElementById('submitBtn').innerHTML;
profileForm.addEventListener('submit', async (e) => {
e.preventDefault();
const submitBtn = document.getElementById('submitBtn');
submitBtn.disabled = true;
submitBtn.innerHTML = '<span class="loading-text"><span class="spinner"></span> Mengupload...</span>';
const csrfToken = document.querySelector('input[name="_csrf"]').value;
const formData = new FormData();
formData.append('name', document.getElementById('editName').value);
formData.append('bio', document.getElementById('editBio').value);
const photoFile = document.getElementById('editPhoto').files[0];
if (photoFile) formData.append('photo', photoFile);
const res = await fetch('/profile', {
method: 'POST',
headers: { 'CSRF-Token': csrfToken },
body: formData
});
const result = await res.json();
submitBtn.disabled = false;
if (result.success) {
const notif = document.getElementById('copyNotification');
if (notif) {
notif.style.display = 'block';
setTimeout(() => { notif.style.display = 'none'; location.reload(); }, 1500);
} else {
alert('Profil berhasil diperbarui!');
location.reload();
}
} else {
submitBtn.innerHTML = originalSubmitText;
alert('Gagal: ' + result.error);
}
});
document.querySelectorAll('.copy-btn').forEach(btn => {
btn.addEventListener('click', () => {
const text = btn.getAttribute('data-copy');
navigator.clipboard.writeText(text).then(() => {
const notif = document.getElementById('copyNotification');
if (notif) { notif.style.display = 'block'; setTimeout(() => notif.style.display = 'none', 1500); }
else alert('Teks disalin!');
});
});
});
let currentOrderId = null;
function openRefundModal(orderId) {
currentOrderId = orderId;
document.getElementById('danaNumber').value = '';
document.getElementById('danaName').value = '';
document.getElementById('refundReason').value = '';
document.getElementById('refundModal').style.display = 'flex';
}
function closeRefundModal() {
document.getElementById('refundModal').style.display = 'none';
currentOrderId = null;
}
document.getElementById('submitRefundBtn').addEventListener('click', async function() {
const danaNumber = document.getElementById('danaNumber').value.trim();
const danaName = document.getElementById('danaName').value.trim();
const reason = document.getElementById('refundReason').value.trim();
if (!danaNumber || !danaName) {
alert('Nomor Dana dan Nama Akun Dana harus diisi!');
return;
}
const confirmMsg = 'Apakah Anda yakin ingin mengajukan refund?\\n\\n' +
'Nomor Dana: ' + danaNumber + '\\n' +
'Nama Akun: ' + danaName + '\\n' +
'Refund hanya dapat diajukan dalam 20 menit setelah pembayaran.';
if (!confirm(confirmMsg)) return;
const btn = this;
const originalText = btn.innerText;
btn.innerText = 'Memproses...';
btn.disabled = true;
try {
const res = await fetch('/api/refund-order', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
order_id: currentOrderId,
dana_number: danaNumber,
dana_name: danaName,
reason: reason
})
});
const data = await res.json();
if (data.success) {
alert('Permintaan refund telah dikirim. Menunggu persetujuan admin.');
location.reload();
} else {
alert('Gagal: ' + (data.message || 'Unknown error'));
closeRefundModal();
}
} catch (err) {
console.error(err);
alert('Terjadi kesalahan, coba lagi nanti.');
closeRefundModal();
} finally {
btn.innerText = originalText;
btn.disabled = false;
}
});
document.querySelectorAll('.refund-btn').forEach(btn => {
btn.addEventListener('click', () => {
const orderId = btn.getAttribute('data-order');
if (orderId) openRefundModal(orderId);
});
});
</script>
</body>
</html>
`;
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

  // ==========================================================================
  // DELETE ACCOUNT
  // ==========================================================================
  app.get('/delete-account', isAuthenticated, async (req, res) => {
    const csrfToken = req.csrfToken();
    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hapus Akun - ${SITE_NAME} Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Rajdhani',sans-serif}
body{background:url('https://files.catbox.moe/e6ickj.jpg') no-repeat center center fixed;background-size:cover;display:flex;justify-content:center;align-items:center;height:100vh;color:#fff;position:relative}
body::before{content:'';position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:0}
.container{background:rgba(15,19,32,0.95);backdrop-filter:blur(10px);border:1px solid #2a3a60;border-radius:24px;padding:40px;width:450px;text-align:center;position:relative;z-index:1;box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 20px #ff444433;animation:glow 3s infinite alternate}
@keyframes glow{0%{box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 20px #ff444433}100%{box-shadow:0 20px 40px rgba(0,0,0,0.8),0 0 40px #ff4444aa}}
h2{font-family:'Orbitron',sans-serif;color:#ff4444;margin-bottom:10px;font-size:28px}
.warning{color:#ffaa00;margin:20px 0;font-size:14px}
.confirm-input{margin:20px 0;text-align:left}
.confirm-input label{display:block;margin-bottom:8px;color:#8a9bb0;font-size:14px}
.confirm-input input{width:100%;padding:12px;border-radius:40px;border:1px solid #1f2a40;background:#1a1f30;color:#fff;font-size:14px}
.btn-group{display:flex;gap:15px;margin-top:30px}
button{padding:12px;border-radius:30px;border:none;font-weight:bold;cursor:pointer;transition:0.2s;flex:1}
.btn-cancel{background:#2a3a60;color:#fff}
.btn-delete{background:#ff4444;color:#fff}
button:hover{transform:scale(1.02);box-shadow:0 0 20px rgba(255,68,68,0.5)}
.back-link{display:inline-block;margin-top:20px;color:#8a9bb0;text-decoration:none}
</style>
</head>
<body>
<div class="container">
<h2>⚠️ Hapus Akun</h2>
<p>Akun ini akan dihapus secara permanen. Semua data terkait (termasuk panel yang dibeli dan foto profil) akan hilang.</p>
<div class="warning">⚠️ Tindakan ini tidak dapat dibatalkan.</div>
<form action="/delete-account" method="POST" id="deleteForm">
<input type="hidden" name="_csrf" value="${csrfToken}">
<div class="confirm-input">
<label>Ketik username <strong>${escapeHTML(req.user.name)}</strong> untuk konfirmasi:</label>
<input type="text" name="confirmUsername" id="confirmUsername" required autocomplete="off">
</div>
<div class="btn-group">
<button type="button" class="btn-cancel" onclick="window.location.href='/'">Batal</button>
<button type="submit" class="btn-delete">Hapus Akun</button>
</div>
</form>
<a href="/" class="back-link">← Kembali ke Beranda</a>
</div>
<script>
document.getElementById('deleteForm').addEventListener('submit', function(e) {
const input = document.getElementById('confirmUsername').value.trim();
const expected = "${escapeHTML(req.user.name)}";
if (input !== expected) {
e.preventDefault();
alert('Username yang dimasukkan tidak sesuai. Penghapusan dibatalkan.');
}
});
</script>
</body>
</html>
`;
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
  // ADMIN DASHBOARD
  // ==========================================================================
  app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
    const users = await getUsers();
    const activeOrders = await getOrders();
    const cancelledOrders = await getCancelledOrders();
    const refundRequests = await getRefundRequests();
    const allOrders = [...activeOrders, ...cancelledOrders];
    const totalUsers = users.filter(u => u.email !== config.ADMIN_EMAIL).length;
    const totalOrders = allOrders.length;
    const totalRevenue = activeOrders.filter(o => o.status === 'paid' || o.status === 'completed').reduce((sum, o) => sum + o.amount, 0);
    const totalLoss = cancelledOrders.filter(o => o.status === 'cancel' || o.status === 'refunded').reduce((sum, o) => sum + o.amount, 0);
    const pendingRefunds = refundRequests.length;
    const sortedOrders = [...allOrders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=0.55">
<title>Admin Dashboard | ${SITE_NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>
* {
margin: 0;
padding: 0;
box-sizing: border-box;
}
body {
font-family: 'Rajdhani', sans-serif;
background: radial-gradient(circle at 20% 30%, #0a0f1a, #03050a);
color: #fff;
min-height: 100vh;
padding: 20px;
position: relative;
overflow-x: hidden;
}
body::before {
content: '';
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: url('https://files.catbox.moe/1sr3hx.jpg') no-repeat center center fixed;
background-size: cover;
opacity: 0.2;
z-index: -2;
pointer-events: none;
}
body::after {
content: '';
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: rgba(0, 0, 0, 0.65);
z-index: -1;
pointer-events: none;
}
.dashboard-container {
max-width: 1600px;
margin: 0 auto;
position: relative;
z-index: 1;
}
.top-bar {
display: flex;
justify-content: space-between;
align-items: center;
background: rgba(15, 25, 45, 0.6);
backdrop-filter: blur(12px);
border-radius: 30px;
padding: 10px 25px;
margin-bottom: 30px;
border: 1px solid rgba(91, 140, 255, 0.3);
box-shadow: 0 8px 20px rgba(0, 0, 0, 0.2);
}
.logo-area h1 {
font-family: 'Orbitron';
font-size: 1.6rem;
background: linear-gradient(135deg, #5b8cff, #9b4dff);
-webkit-background-clip: text;
background-clip: text;
color: transparent;
letter-spacing: 1px;
}
.logo-area h1 i {
margin-right: 8px;
background: none;
color: #5b8cff;
-webkit-background-clip: unset;
background-clip: unset;
}
.admin-profile {
display: flex;
align-items: center;
gap: 15px;
background: rgba(0, 0, 0, 0.4);
padding: 5px 15px 5px 10px;
border-radius: 50px;
border-left: 2px solid #5b8cff;
}
.admin-avatar {
width: 42px;
height: 42px;
border-radius: 50%;
border: 2px solid #5b8cff;
object-fit: cover;
background: #1a1f30;
}
.admin-info {
text-align: right;
}
.admin-name {
font-weight: bold;
font-size: 1rem;
color: #fff;
}
.admin-role {
font-size: 0.75rem;
color: #8a9bb0;
letter-spacing: 0.5px;
}
.back-link {
color: #8a9bb0;
text-decoration: none;
transition: 0.2s;
margin-left: 15px;
}
.back-link:hover {
color: #5b8cff;
}
.stats-grid {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
gap: 20px;
margin-bottom: 40px;
}
.stat-card {
background: rgba(15, 25, 45, 0.6);
backdrop-filter: blur(8px);
border: 1px solid rgba(91, 140, 255, 0.3);
border-radius: 24px;
padding: 20px;
text-align: center;
transition: all 0.3s ease;
position: relative;
overflow: hidden;
}
.stat-card::before {
content: '';
position: absolute;
top: 0;
left: -100%;
width: 100%;
height: 100%;
background: linear-gradient(90deg, transparent, rgba(91, 140, 255, 0.2), transparent);
transition: left 0.5s;
}
.stat-card:hover {
transform: translateY(-5px);
border-color: #5b8cff;
box-shadow: 0 10px 25px rgba(91, 140, 255, 0.2);
}
.stat-card:hover::before {
left: 100%;
}
.stat-card h3 {
font-size: 0.9rem;
color: #8a9bb0;
text-transform: uppercase;
letter-spacing: 1px;
margin-bottom: 12px;
}
.stat-card .number {
font-size: 2.5rem;
font-weight: bold;
font-family: 'Orbitron';
color: #ffcc00;
text-shadow: 0 0 10px rgba(255, 204, 0, 0.5);
}
.server-status-section {
background: rgba(15, 25, 45, 0.6);
backdrop-filter: blur(8px);
border-radius: 24px;
padding: 20px;
margin-bottom: 40px;
border: 1px solid rgba(91, 140, 255, 0.3);
}
.section-header {
display: flex;
justify-content: space-between;
align-items: baseline;
margin-bottom: 20px;
border-bottom: 1px solid rgba(91, 140, 255, 0.3);
padding-bottom: 10px;
}
.section-header h2 {
font-family: 'Orbitron';
font-size: 1.4rem;
color: #5b8cff;
letter-spacing: 1px;
}
.section-header h2 i {
margin-right: 8px;
}
.last-update {
font-size: 0.7rem;
color: #8a9bb0;
}
.status-metrics {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
gap: 20px;
margin-bottom: 20px;
}
.metric-card {
background: rgba(0, 0, 0, 0.4);
border-radius: 20px;
padding: 15px;
border-left: 3px solid #5b8cff;
}
.metric-header {
display: flex;
justify-content: space-between;
margin-bottom: 12px;
font-size: 0.9rem;
color: #bbb;
}
.bar-container {
display: flex;
align-items: flex-end;
gap: 6px;
height: 70px;
margin: 10px 0;
padding: 5px;
}
.bar {
flex: 1;
background: linear-gradient(to top, #5b8cff, #9b4dff);
border-radius: 4px 4px 0 0;
transition: height 0.3s ease;
}
.metric-value {
text-align: right;
font-family: monospace;
font-size: 0.9rem;
color: #ffcc00;
}
.info-grid {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
gap: 15px;
margin-top: 15px;
}
.info-item {
background: rgba(0, 0, 0, 0.3);
border-radius: 12px;
padding: 12px;
text-align: center;
}
.info-item .label {
font-size: 0.7rem;
color: #8a9bb0;
text-transform: uppercase;
margin-bottom: 5px;
}
.info-item .value {
font-family: 'Orbitron';
font-size: 1.1rem;
font-weight: bold;
color: #fff;
}
.section-title {
font-family: 'Orbitron';
font-size: 1.4rem;
color: #5b8cff;
margin: 30px 0 15px;
border-left: 4px solid #5b8cff;
padding-left: 15px;
display: flex;
justify-content: space-between;
align-items: center;
flex-wrap: wrap;
gap: 10px;
}
.search-box {
background: rgba(0, 0, 0, 0.5);
border: 1px solid #2a3a60;
border-radius: 30px;
padding: 5px 15px;
display: flex;
align-items: center;
gap: 8px;
}
.search-box i {
color: #8a9bb0;
}
.search-box input {
background: transparent;
border: none;
color: #fff;
padding: 6px 0;
font-size: 0.9rem;
outline: none;
width: 180px;
}
.table-wrapper {
overflow-x: auto;
background: rgba(15, 25, 45, 0.6);
backdrop-filter: blur(8px);
border-radius: 20px;
border: 1px solid rgba(91, 140, 255, 0.3);
margin-bottom: 30px;
}
.table-wrapper.scrollable-table {
max-height: 500px;
overflow-y: auto;
}
table {
width: 100%;
border-collapse: collapse;
font-size: 0.9rem;
}
th, td {
padding: 12px 15px;
text-align: left;
border-bottom: 1px solid rgba(91, 140, 255, 0.2);
}
th {
color: #5b8cff;
font-weight: 600;
background: rgba(0, 0, 0, 0.3);
position: sticky;
top: 0;
backdrop-filter: blur(4px);
}
tr:hover {
background: rgba(91, 140, 255, 0.1);
}
.status-paid { color: #4caf50; font-weight: bold; }
.status-pending { color: #ff9800; font-weight: bold; }
.status-cancel, .status-refunded { color: #f44336; font-weight: bold; }
.user-avatar {
width: 36px;
height: 36px;
border-radius: 50%;
object-fit: cover;
vertical-align: middle;
margin-right: 8px;
border: 1px solid #5b8cff;
}
.user-bio {
max-width: 180px;
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
color: #aaa;
font-size: 0.8rem;
}
.action-btn {
background: #f44336;
color: #fff;
border: none;
padding: 5px 12px;
border-radius: 20px;
cursor: pointer;
font-size: 0.75rem;
transition: 0.2s;
}
.action-btn:hover {
background: #d32f2f;
transform: scale(1.02);
}
.action-btn.refund-btn {
background: #4caf50;
}
.action-btn.refund-btn:hover {
background: #388e3c;
}
.action-btn.approve-btn {
background: #2196f3;
}
.action-btn.approve-btn:hover {
background: #1976d2;
}
.email-cell {
max-width: 200px;
white-space: nowrap;
overflow-x: auto;
scrollbar-width: thin;
}
.refund-request {
background: rgba(33, 150, 243, 0.15);
}
.footer {
text-align: center;
padding: 20px;
margin-top: 30px;
border-top: 1px solid #2a3a60;
color: #8a9bb0;
font-size: 0.7rem;
}
@media (max-width: 768px) {
.top-bar {
flex-direction: column;
gap: 15px;
text-align: center;
}
.admin-profile {
justify-content: center;
}
.stats-grid {
grid-template-columns: 1fr;
}
.section-title {
flex-direction: column;
align-items: flex-start;
}
.search-box input {
width: 100%;
}
th, td {
padding: 8px 10px;
font-size: 0.8rem;
}
}
</style>
</head>
<body>
<div class="dashboard-container">
<div class="top-bar">
<div class="logo-area">
<h1><i class="fas fa-chart-line"></i> ${SITE_NAME} | ADMIN</h1>
</div>
<div class="admin-profile">
<img src="${req.user.photo ? `/api/avatar/${req.user.id}` : getGravatarUrl(req.user.email, 50)}" class="admin-avatar" alt="Admin">
<div class="admin-info">
<div class="admin-name">${escapeHTML(req.user.name)}</div>
<div class="admin-role">Administrator</div>
</div>
<a href="/profile" class="back-link"><i class="fas fa-arrow-left"></i> Profil</a>
</div>
</div>
<div class="stats-grid">
<div class="stat-card"><h3><i class="fas fa-users"></i> Total Pengguna</h3><div class="number">${totalUsers}</div></div>
<div class="stat-card"><h3><i class="fas fa-shopping-cart"></i> Total Order</h3><div class="number">${totalOrders}</div></div>
<div class="stat-card"><h3><i class="fas fa-chart-line"></i> Pendapatan</h3><div class="number">Rp ${totalRevenue.toLocaleString('id-ID')}</div></div>
<div class="stat-card"><h3><i class="fas fa-chart-line"></i> Kerugian</h3><div class="number">Rp ${totalLoss.toLocaleString('id-ID')}</div></div>
<div class="stat-card"><h3><i class="fas fa-clock"></i> Refund Pending</h3><div class="number">${pendingRefunds}</div></div>
</div>
<div class="server-status-section">
<div class="section-header">
<h2><i class="fas fa-server"></i> Server Status</h2>
<span class="last-update" id="lastUpdateTime">Memuat...</span>
</div>
<div class="status-metrics">
<div class="metric-card">
<div class="metric-header"><span>CPU Load</span><span id="cpuValue">0%</span></div>
<div class="bar-container" id="cpuBars"></div>
</div>
<div class="metric-card">
<div class="metric-header"><span>Memory Usage</span><span id="memValue">0 MiB</span></div>
<div class="bar-container" id="memBars"></div>
</div>
<div class="metric-card">
<div class="metric-header"><span>Network Traffic</span><span id="netValue">0 B/s</span></div>
<div class="bar-container" id="netBars"></div>
</div>
</div>
<div class="info-grid" id="serverInfoGrid">
<div class="info-item"><div class="label">VERSION</div><div class="value" id="serverVersion">-</div></div>
<div class="info-item"><div class="label">DEVELOPER</div><div class="value" id="serverDev">-</div></div>
<div class="info-item"><div class="label">UPTIME</div><div class="value" id="serverUptime">-</div></div>
<div class="info-item"><div class="label">SERVER TIME</div><div class="value" id="serverTime">-</div></div>
</div>
</div>
<div class="section-title">
<span><i class="fas fa-clock"></i> Verif cancel</span>
<div class="search-box"><i class="fas fa-search"></i><input type="text" id="searchRefund" placeholder="Cari order/email..."></div>
</div>
<div class="table-wrapper scrollable-table">
<table id="refundTable">
<thead>
<tr><th>Order ID</th><th>Email</th><th>Paket</th><th>Jumlah</th><th>Diajukan</th><th>Aksi</th></tr>
</thead>
<tbody>
${refundRequests.map(r => `
<tr class="refund-request">
<td>${r.order_id}</td>
<td class="email-cell" title="${escapeHTML(r.email)}">${escapeHTML(r.email)}</td>
<td>${r.panel_type.toUpperCase()}</td>
<td>Rp ${r.amount.toLocaleString('id-ID')}</td>
<td>${new Date(r.requested_at).toLocaleString('id-ID')}</td>
<td><button class="action-btn approve-btn" onclick="approveRefund('${r.order_id}')">Setujui Refund</button></td>
</tr>
`).join('')}
${refundRequests.length === 0 ? '<tr><td colspan="6">Tidak ada permintaan refund</td></tr>' : ''}
</tbody>
</table>
</div>
<div class="section-title">
<span><i class="fas fa-users"></i> Daftar User</span>
<div class="search-box"><i class="fas fa-search"></i><input type="text" id="searchUser" placeholder="Cari nama/email..."></div>
</div>
<div class="table-wrapper scrollable-table">
<table id="userTable">
<thead>
<tr><th>ID</th><th>Profil</th><th>Nama</th><th>Email</th><th>Bergabung</th><th>Panel Dibeli</th><th>Pending</th><th>Cancel/Refund</th><th>Bio</th></tr>
</thead>
<tbody>
${userData.map(u => `
<tr>
<td>${u.id}</td>
<td><img src="${u.photo}" class="user-avatar" alt="Avatar"></td>
<td>${escapeHTML(u.name)}</td>
<td class="email-cell" title="${escapeHTML(u.email)}">${escapeHTML(u.email)}</td>
<td>${u.joined}</td>
<td>${u.purchasedCount}</td>
<td>${u.pendingCount}</td>
<td>${u.cancelCount}</td>
<td class="user-bio" title="${escapeHTML(u.bio)}">${escapeHTML(u.bio)}</td>
</tr>
`).join('')}
${userData.length === 0 ? '<tr><td colspan="9">Belum ada user</td></tr>' : ''}
</tbody>
</table>
</div>
<div class="section-title">
<span><i class="fas fa-shopping-cart"></i> Order Terbaru</span>
<div class="search-box"><i class="fas fa-search"></i><input type="text" id="searchOrder" placeholder="Cari order/email..."></div>
</div>
<div class="table-wrapper scrollable-table">
<table id="orderTable">
<thead>
<tr><th>Order ID</th><th>Email</th><th>Paket</th><th>Jumlah</th><th>Status</th><th>Tanggal</th><th>Aksi</th></tr>
</thead>
<tbody>
${sortedOrders.slice(0, 100).map(o => {
let actionBtn = '';
if (o.status === 'pending') {
actionBtn = `<button class="action-btn" onclick="cancelOrder('${o.order_id}')">Batalkan</button>`;
} else if (o.status === 'paid' || o.status === 'completed') {
actionBtn = `<button class="action-btn refund-btn" onclick="refundOrder('${o.order_id}')">Refund (Manual)</button>`;
}
return `
<tr>
<td>${o.order_id}</td>
<td class="email-cell" title="${escapeHTML(o.email)}">${escapeHTML(o.email)}</td>
<td>${o.panel_type.toUpperCase()}</td>
<td>Rp ${o.amount.toLocaleString('id-ID')}</td>
<td class="status-${o.status === 'paid' || o.status === 'completed' ? 'paid' : (o.status === 'cancel' || o.status === 'refunded' ? 'cancel' : 'pending')}">${o.status}</td>
<td>${new Date(o.created_at).toLocaleDateString('id-ID')}</td>
<td>${actionBtn}</td>
</tr>
`;
}).join('')}
${sortedOrders.length === 0 ? '<tr><td colspan="7">Belum ada order</td></tr>' : ''}
</tbody>
</table>
</div>
<div class="footer">
<p>© 2026 ${SITE_NAME} Admin Panel • ${config.DEVELOPER} • v${config.VERSI_WEB}</p>
</div>
</div>
<script>
function initBars(containerId, barCount = 20) {
const container = document.getElementById(containerId);
if (!container) return [];
container.innerHTML = '';
for (let i = 0; i < barCount; i++) {
const bar = document.createElement('div');
bar.className = 'bar';
bar.style.height = '5px';
container.appendChild(bar);
}
return Array.from(container.children);
}
function getColorForHeight(height, maxHeight) {
const ratio = Math.min(1, Math.max(0, height / maxHeight));
const hue = 120 * (1 - ratio);
return 'hsl(' + hue + ', 100%, 60%)';
}
function updateBars(bars, basePercent) {
if (!bars || bars.length === 0) return;
const maxHeight = 70;
bars.forEach((bar, idx) => {
let randomFactor = (Math.random() - 0.5) * 0.3;
let percent = Math.min(100, Math.max(0, basePercent * (1 + randomFactor)));
let height = (percent / 100) * maxHeight;
bar.style.height = height + 'px';
bar.style.background = getColorForHeight(height, maxHeight);
});
}
const cpuBars = initBars('cpuBars', 20);
const memBars = initBars('memBars', 20);
const netBars = initBars('netBars', 20);
function updateMetrics() {
const cpu = (Math.random() * 40).toFixed(1);
const mem = Math.floor(Math.random() * 500);
const net = Math.floor(Math.random() * 800);
document.getElementById('cpuValue').innerText = cpu + '%';
document.getElementById('memValue').innerText = mem + ' MiB';
document.getElementById('netValue').innerText = net + ' B/s';
updateBars(cpuBars, parseFloat(cpu));
updateBars(memBars, (mem / 500) * 100);
updateBars(netBars, (net / 1000) * 100);
}
async function fetchServerStatus() {
try {
const res = await fetch('/api/status');
const data = await res.json();
document.getElementById('serverVersion').innerText = data.version;
document.getElementById('serverDev').innerText = data.developer;
const uptime = formatUptime(data.uptime);
document.getElementById('serverUptime').innerText = uptime;
document.getElementById('serverTime').innerText = new Date(data.timestamp).toLocaleTimeString('id-ID');
document.getElementById('lastUpdateTime').innerText = 'Diperbarui: ' + new Date().toLocaleTimeString('id-ID');
} catch (e) {
document.getElementById('serverVersion').innerText = 'Error';
document.getElementById('serverDev').innerText = 'Error';
document.getElementById('serverUptime').innerText = 'Error';
document.getElementById('serverTime').innerText = 'Error';
}
}
function formatUptime(seconds) {
const d = Math.floor(seconds / 86400);
const h = Math.floor((seconds % 86400) / 3600);
const m = Math.floor((seconds % 3600) / 60);
const s = Math.floor(seconds % 60);
return d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
}
setInterval(() => {
updateMetrics();
fetchServerStatus();
}, 5000);
updateMetrics();
fetchServerStatus();
function filterTable(inputId, tableId) {
const input = document.getElementById(inputId);
if (!input) return;
input.addEventListener('keyup', function() {
const filter = this.value.toLowerCase();
const rows = document.querySelectorAll('#' + tableId + ' tbody tr');
rows.forEach(row => {
const text = row.innerText.toLowerCase();
row.style.display = text.includes(filter) ? '' : 'none';
});
});
}
filterTable('searchRefund', 'refundTable');
filterTable('searchUser', 'userTable');
filterTable('searchOrder', 'orderTable');
async function cancelOrder(orderId) {
if (!confirm('Yakin ingin membatalkan order pending ini? Dana akan dikembalikan ke user.')) return;
try {
const res = await fetch('/api/cancel-order', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ order_id: orderId })
});
const data = await res.json();
if (data.success) {
alert('Order berhasil dibatalkan');
location.reload();
} else {
alert('Gagal: ' + (data.message || 'Unknown error'));
}
} catch (err) {
console.error(err);
alert('Terjadi kesalahan, coba lagi nanti.');
}
}
async function refundOrder(orderId) {
if (!confirm('Yakin ingin melakukan refund untuk order ini? Dana harus dikembalikan secara manual di dashboard Pakasir, dan server akan dinonaktifkan.')) return;
try {
const res = await fetch('/api/approve-refund', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ order_id: orderId })
});
const data = await res.json();
if (data.success) {
alert('Refund berhasil diproses');
location.reload();
} else {
alert('Gagal: ' + (data.message || 'Unknown error'));
}
} catch (err) {
console.error(err);
alert('Terjadi kesalahan, coba lagi nanti.');
}
}
async function approveRefund(orderId) {
if (!confirm('Setujui refund untuk order ini? Server akan dihapus dan status order akan diubah menjadi refunded. Dana harus dikembalikan secara manual di dashboard Pakasir.')) return;
try {
const res = await fetch('/api/approve-refund', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ order_id: orderId })
});
const data = await res.json();
if (data.success) {
alert('Refund berhasil disetujui dan diproses');
location.reload();
} else {
alert('Gagal: ' + (data.message || 'Unknown error'));
}
} catch (err) {
console.error(err);
alert('Terjadi kesalahan, coba lagi nanti.');
}
}
</script>
</body>
</html>
`;
    res.send(html);
  });

// ==========================================================================
// HALAMAN UTAMA (HOME) – BACKGROUND GAMBAR PADA SETIAP KARTU HARGA
// ==========================================================================
app.get('/', async (req, res) => {
  const isLoggedIn = req.isAuthenticated();
  const user = isLoggedIn ? req.user : null;
  const photoUrl = user ? (user.photo ? `/api/avatar/${user.id}` : getGravatarUrl(user.email, 40)) : null;
  const safeName = user ? escapeHTML(user.name) : 'Pengunjung';
  const users = await getUsers();
  const orders = await getOrders();
  const totalUsers = users.filter(u => u.email !== config.ADMIN_EMAIL).length;
  let totalPurchases = 0;
  if (user) {
    totalPurchases = orders
      .filter(o => o.email === user.email && o.panel_created === true && o.status === 'paid')
      .reduce((sum, o) => sum + o.amount, 0);
  }
  const whatsappNumber = (config.WHATSAPP || '').replace(/\D/g, '');
  const telegramUsername = (config.DEVELOPER || '').replace('@', '');
  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=0.65, user-scalable=yes">
<title>${SITE_NAME} cPanel Store | Beli Panel Pterodactyl Otomatis</title>
<meta name="description" content="Beli panel Pterodactyl dengan mudah dan cepat. Pembayaran otomatis via QRIS, panel langsung aktif. Pilihan RAM 1GB hingga Unlimited. Aktivasi instan, garansi refund 20 menit.">
<meta name="keywords" content="beli panel pterodactyl">
<meta name="author" content="${config.DEVELOPER}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${config.URL}">
<meta property="og:title" content="${SITE_NAME} cPanel Store - Panel Pterodactyl Instan">
<meta property="og:description" content="Dapatkan panel Pterodactyl dengan mudah dan cepat. Pembayaran otomatis, panel langsung aktif. Pilih paket sesuai kebutuhan Anda.">
<meta property="og:image" content="${config.FAVICON}">
<meta property="og:url" content="${config.URL}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME} cPanel">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${SITE_NAME} cPanel Store - Panel Pterodactyl Instan">
<meta name="twitter:description" content="Beli panel Pterodactyl dengan mudah dan cepat. Pembayaran otomatis, panel langsung aktif. Aktivasi instan!">
<meta name="google-site-verification" content="${config.GOOGLE_VERIF}" />
<meta name="twitter:image" content="${config.FAVICON}">
<link rel="icon" type="image/jpeg" href="${config.FAVICON}">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&family=VT323&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body {
  font-family: 'Rajdhani', sans-serif;
  background: #0a0c14;
  color: #fff;
  min-height: 100vh;
  padding-bottom: 40px;
  position: relative;
  overflow-x: hidden;
}
#bgCanvas {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  pointer-events: none;
}
.custom-header {
  position: sticky; top: 0; width: 100%; height: 55px;
  background: rgba(10, 12, 20, 0.95); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px; z-index: 100; border-bottom: 1px solid #1f2a40;
}
.logo-container {
  display: flex;
  align-items: center;
  gap: 12px;
}
.header-logo {
  height: 48px;
  width: auto;
  border-radius: 10px;
  transition: transform 0.2s;
}
.header-logo:hover {
  transform: scale(1.05);
}
.header-title {
  font-family: 'Orbitron'; font-size: 20px; color: #5b8cff; letter-spacing: 1px;
  text-decoration: none;
}
.header-title:hover { text-decoration: underline; }
.header-right {
  display: flex;
  align-items: center;
  gap: 15px;
  flex-wrap: wrap;
}
.info-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(0,0,0,0.4);
  padding: 4px 12px;
  border-radius: 40px;
  backdrop-filter: blur(4px);
}
.stat-badge {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
}
.stat-badge i {
  font-size: 12px;
  color: #ffcc00;
}
.stat-badge span:first-child {
  color: #8a9bb0;
}
.stat-badge span:last-child {
  font-weight: bold;
  color: #fff;
  font-family: monospace;
}
.info-btn {
  background: rgba(91,140,255,0.2);
  border: none;
  color: #5b8cff;
  font-size: 18px;
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: 0.2s;
}
.info-btn:hover {
  background: #5b8cff;
  color: #000;
  transform: scale(1.05);
}
.support-btn {
  background: rgba(91,140,255,0.2);
  border: none;
  color: #5b8cff;
  font-size: 18px;
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: 0.2s;
}
.support-btn:hover {
  background: #5b8cff;
  color: #000;
  transform: scale(1.05);
}
.support-dropdown {
  display: none;
  position: absolute;
  top: 55px;
  right: 100px;
  background: #0f1320;
  border: 1px solid #2a3a60;
  border-radius: 12px;
  min-width: 180px;
  box-shadow: 0 8px 16px rgba(0,0,0,0.7);
  z-index: 102;
  overflow: hidden;
}
.support-dropdown a.support-item {
  color: #fff;
  padding: 12px 16px;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: 0.2s;
}
.support-dropdown a.support-item:hover {
  background: #1a1f30;
  color: #5b8cff;
}
.support-dropdown.show {
  display: block;
}
.user-dropdown {
  position: relative;
  display: inline-block;
}
.user-dropdown-content {
  display: none;
  position: absolute;
  right: 0;
  background: #0f1320;
  border: 1px solid #2a3a60;
  border-radius: 12px;
  min-width: 160px;
  box-shadow: 0 8px 16px rgba(0,0,0,0.7);
  z-index: 101;
  overflow: hidden;
}
.user-dropdown-content a, .user-dropdown-content button {
  color: #fff;
  padding: 12px 16px;
  text-decoration: none;
  display: block;
  background: none;
  border: none;
  width: 100%;
  text-align: left;
  font-size: 14px;
  cursor: pointer;
  transition: 0.2s;
}
.user-dropdown-content a:hover, .user-dropdown-content button:hover {
  background: #1a1f30;
  color: #5b8cff;
}
.user-dropdown:hover .user-dropdown-content {
  display: block;
}
.user-avatar {
  width: 35px;
  height: 35px;
  border-radius: 50%;
  border: 2px solid #5b8cff;
  cursor: pointer;
  transition: 0.2s;
}
.user-avatar:hover {
  transform: scale(1.05);
  box-shadow: 0 0 15px #5b8cff;
}
.login-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: linear-gradient(90deg, #1e3c72, #2a5298);
  padding: 6px 14px;
  border-radius: 40px;
  color: #fff;
  text-decoration: none;
  font-weight: bold;
  transition: 0.2s;
}
.login-btn:hover {
  transform: scale(1.02);
  box-shadow: 0 0 15px #5b8cff;
}
.menu-btn {
  width: 40px; height: 40px; display: flex; flex-direction: column;
  justify-content: center; align-items: center; gap: 5px; cursor: pointer;
  border-radius: 8px; transition: 0.2s;
}
.menu-btn:hover { background: #1f2a40; }
.menu-btn span {
  width: 22px; height: 2px; background: #fff; border-radius: 2px;
  transition: 0.3s;
}
.menu-btn.active span:nth-child(1) { transform: rotate(45deg) translate(6px, 6px); }
.menu-btn.active span:nth-child(2) { opacity: 0; }
.menu-btn.active span:nth-child(3) { transform: rotate(-45deg) translate(6px, -6px); }
.status-panel {
  position: fixed;
  top: -100%;
  left: 0;
  width: 100%;
  background: #0f1320;
  border-bottom: 2px solid #2a3a60;
  box-shadow: 0 10px 20px rgba(0,0,0,0.7);
  z-index: 99;
  transition: top 0.4s ease;
  padding: 70px 20px 20px 20px;
  backdrop-filter: blur(8px);
}
.status-panel.show { top: 0; }
.status-panel h3 {
  font-family: 'Orbitron';
  color: #5b8cff;
  margin-bottom: 20px;
  font-size: 24px;
  text-align: center;
}
.metric-row {
  margin-bottom: 20px;
  background: #0b0e18;
  border-radius: 12px;
  padding: 15px;
  border: 1px solid #1f2a40;
}
.metric-header {
  display: flex;
  justify-content: space-between;
  color: #8a9bb0;
  font-size: 16px;
  margin-bottom: 10px;
}
.bar-container {
  position: relative;
  width: 100%;
  height: 80px;
  background: rgba(0,0,0,0.4);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 5px 10px;
}
.bar {
  width: 8px;
  border-radius: 3px 3px 0 0;
  transition: height 0.2s ease, background 0.1s ease;
  box-shadow: 0 0 3px rgba(255,255,255,0.3);
}
.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
  margin-top: 25px;
}
.status-item {
  background: #1a1f30;
  border-radius: 8px;
  padding: 12px;
  border-left: 3px solid #3a6df0;
}
.status-item .label { color: #8a9bb0; font-size: 12px; text-transform: uppercase; }
.status-item .value { color: #fff; font-size: 18px; font-weight: bold; font-family: 'VT323'; }
.page-container { padding: 20px; transition: filter 0.3s; }
.page-container.blur { filter: blur(3px); pointer-events: none; }
.lux-header-card {
  background: linear-gradient(135deg, #1a2a48, #14233c);
  border-radius: 16px; padding: 20px; margin-bottom: 25px;
  border: 1px solid #2a3a60;
}
.lux-header-card h2 { font-family: 'Orbitron'; font-size: 20px; color: #5b8cff; }
.lux-header-card p { font-size: 14px; color: #a0b0c0; }
.lux-section-title {
  font-family: 'Orbitron'; font-size: 16px; color: #fff; margin-bottom: 15px;
  padding-left: 8px; border-left: 4px solid #5b8cff;
}
.slider-container {
  width: 100%; background: #101520; border-radius: 12px; overflow: hidden;
  border: 1px solid #1f2a40; margin-bottom: 25px; height: 150px;
  touch-action: pan-y; cursor: grab; user-select: none;
}
.slider-track { display: flex; width: 200%; height: 100%; transition: transform 0.4s; }
.slide { width: 50%; height: 100%; position: relative; flex-shrink: 0; }
.slide video { width: 100%; height: 100%; object-fit: cover; display: block; }
.slide-content {
  position: absolute; bottom: 0; left: 0; width: 100%; padding: 15px;
  background: linear-gradient(to top, rgba(0,0,0,0.9), transparent);
}
.slide-content h3 { font-family: 'Orbitron'; font-size: 14px; color: #fff; }
.slide-content p { font-size: 12px; color: #ccc; }
.pricing-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 25px;
  margin-bottom: 30px;
}
.price-card {
  position: relative;
  background: url('https://files.catbox.moe/sgjra6.png') no-repeat center center;
  background-size: cover;
  border-radius: 20px;
  padding: 20px;
  overflow: hidden;
  transition: all 0.3s ease;
  text-align: center;
  box-shadow: 0 5px 15px rgba(0,0,0,0.3);
  animation: float 3s ease-in-out infinite;
}
@keyframes float {
  0% { transform: translateY(0px); }
  50% { transform: translateY(-8px); }
  100% { transform: translateY(0px); }
}
.price-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.65);
  border-radius: 20px;
  z-index: 0;
}
.price-card > * {
  position: relative;
  z-index: 1;
}
.price-card:hover {
  transform: translateY(-10px) scale(1.02);
  border-color: #5b8cff;
  box-shadow: 0 15px 35px rgba(91,140,255,0.4);
  animation: none;
}
.panel-type {
  font-family: 'Orbitron';
  font-size: 1.6rem;
  color: #5b8cff;
  margin-bottom: 10px;
  text-transform: uppercase;
  text-shadow: 0 0 8px #5b8cff;
}
.panel-specs {
  font-size: 0.95rem;
  color: #f0f0f0;
  margin-bottom: 15px;
  line-height: 1.6;
  background: rgba(0,0,0,0.5);
  border-radius: 12px;
  padding: 8px;
}
.price {
  font-size: 2rem;
  font-weight: bold;
  color: #ffcc00;
  margin: 15px 0;
  text-shadow: 0 0 5px #ffaa00;
}
.buy-btn {
  width: 100%;
  padding: 12px;
  background: linear-gradient(90deg, #1e3c72, #2a5298);
  border: none;
  border-radius: 50px;
  color: #fff;
  font-family: 'Orbitron';
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
  transition: 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.buy-btn:hover {
  transform: scale(1.02);
  box-shadow: 0 0 15px #5b8cff;
}
.modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.9);
  z-index: 2000;
  align-items: center;
  justify-content: center;
}
.modal-content {
  background: #0b0f19;
  padding: 30px;
  border-radius: 20px;
  max-width: 450px;
  width: 90%;
  text-align: center;
  border: 2px solid #5b8cff;
  box-shadow: 0 0 30px rgba(91,140,255,0.3);
}
.modal h2 {
  font-family: 'Orbitron';
  color: #5b8cff;
  margin-bottom: 20px;
  font-size: 1.5rem;
}
.modal-buttons {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
.modal-btn {
  flex: 1;
  padding: 12px;
  border-radius: 30px;
  border: none;
  font-weight: bold;
  cursor: pointer;
  transition: 0.2s;
}
.modal-btn.cancel {
  background: #2a3a60;
  color: #fff;
}
.modal-btn.confirm {
  background: linear-gradient(90deg, #1e3c72, #2a5298);
  color: #fff;
}
.modal-gif {
  width: 120px;
  margin: 0 auto 20px;
  display: block;
  border-radius: 12px;
}
.footer {
  text-align: center;
  padding: 20px;
  margin-top: 30px;
  border-top: 1px solid #1f2a40;
  color: #8a9bb0;
  font-size: 12px;
}
.info-text {
  text-align: left;
  margin: 20px 0;
  line-height: 1.6;
  color: #ddd;
}
.info-text p {
  margin-bottom: 12px;
}
.info-text ul {
  margin-left: 20px;
  margin-top: 8px;
}
.info-text li {
  margin-bottom: 6px;
}
@media (max-width: 768px) {
  .header-right {
    gap: 8px;
  }
  .info-stats {
    gap: 6px;
    padding: 2px 8px;
  }
  .stat-badge {
    font-size: 10px;
  }
  .stat-badge i {
    font-size: 10px;
  }
  .info-btn {
    width: 28px;
    height: 28px;
    font-size: 14px;
  }
  .support-btn {
    width: 28px;
    height: 28px;
    font-size: 14px;
  }
  .support-dropdown {
    right: 70px;
    top: 50px;
  }
  .user-avatar {
    width: 30px;
    height: 30px;
  }
  .header-logo {
    height: 38px;
  }
  .header-title {
    font-size: 16px;
  }
  .logo-container {
    gap: 6px;
  }
  .price-card {
    padding: 15px;
  }
  .panel-type {
    font-size: 1.3rem;
  }
}
</style>
</head>
<body>
<canvas id="bgCanvas"></canvas>
<div class="custom-header">
<div class="logo-container">
<img src="https://files.catbox.moe/u47x3d.png" alt="Logo ${SITE_NAME}" class="header-logo">
<a href="/" class="header-title">${SITE_NAME} CPANEL</a>
</div>
<div class="header-right">
<button class="info-btn" id="infoBtn"><i class="fas fa-info-circle"></i></button>
<button class="support-btn" id="supportBtn"><i class="fas fa-headset"></i></button>
<div class="support-dropdown" id="supportDropdown">
<a href="https://wa.me/${whatsappNumber}" target="_blank" class="support-item">
<i class="fab fa-whatsapp"></i> Chat WhatsApp
</a>
<a href="https://t.me/${telegramUsername}" target="_blank" class="support-item">
<i class="fab fa-telegram"></i> Chat Telegram
</a>
</div>
<div class="info-stats">
${isLoggedIn ? `
<div class="stat-badge"><i class="fas fa-shopping-cart"></i><span>Total Beli:</span><span>Rp ${totalPurchases.toLocaleString('id-ID')}</span></div>
` : ''}
<div class="stat-badge"><i class="fas fa-users"></i><span>Total User:</span><span>${totalUsers}</span></div>
</div>
${isLoggedIn ? `
<div class="user-dropdown">
<img src="${photoUrl}" class="user-avatar" alt="Avatar">
<div class="user-dropdown-content">
<a href="/profile"><i class="fas fa-user"></i> Profil</a>
<a href="/logout"><i class="fas fa-sign-out-alt"></i> Keluar Akun</a>
<a href="/delete-account"><i class="fas fa-trash"></i> Hapus Akun</a>
</div>
</div>
` : `
<a href="/login" class="login-btn"><i class="fas fa-sign-in-alt"></i> Login</a>
`}
<div class="menu-btn" id="menuBtn">
<span></span><span></span><span></span>
</div>
</div>
</div>
<div class="status-panel" id="statusPanel">
<h3><i class="fas fa-chart-line"></i> SERVER STATUS</h3>
<div class="metric-row">
<div class="metric-header"><span>CPU Load</span><span id="cpuValue">0.0%</span></div>
<div class="bar-container" id="cpuBars"></div>
</div>
<div class="metric-row">
<div class="metric-header"><span>Memory</span><span id="memValue">0 MiB</span></div>
<div class="bar-container" id="memBars"></div>
</div>
<div class="metric-row">
<div class="metric-header"><span>Network</span><span id="netValue">0 B/s</span></div>
<div class="bar-container" id="netBars"></div>
</div>
<div id="statusContent" class="status-grid">Memuat...</div>
</div>
<div class="page-container" id="pageContainer">
<div class="lux-header-card">
<h2>${SITE_NAME} cPanel Store</h2>
<p>Selamat datang, ${safeName}! Pilih paket panel Pterodactyl di bawah ini.</p>
</div>
<div class="slider-container" id="newsSlider">
<div class="slider-track">
<div class="slide"><video src="https://files.catbox.moe/8v8txh.mp4" autoplay muted loop playsinline></video><div class="slide-content"><h3>${SITE_NAME} cPanel v${config.VERSI_WEB}</h3><p>Panel Pterodactyl siap pakai</p></div></div>
<div class="slide"><video src="https://files.catbox.moe/cqdqmg.mp4" autoplay muted loop playsinline></video><div class="slide-content"><h3>Mudah & Cepat</h3><p>Pembayaran otomatis, panel langsung aktif</p></div></div>
</div>
</div>
<div class="lux-section-title">Pilih Paket Server</div>
<div class="pricing-grid" id="pricingGrid"></div>
<div class="footer">
<p>© 2026 ${SITE_NAME} • ${config.DEVELOPER} • v${config.VERSI_WEB}</p>
</div>
</div>
<div id="infoModal" class="modal">
<div class="modal-content">
<h2><i class="fas fa-info-circle"></i> Tentang ${SITE_NAME}</h2>
<div class="info-text">
<p><strong>${SITE_NAME} cPanel Store</strong> adalah platform pembelian panel Pterodactyl dengan sistem otomatis. Nikmati kemudahan mendapatkan server game atau aplikasi Anda sendiri.</p>
<p><strong>✨ Fitur Unggulan:</strong></p>
<ul>
<li>✅ <strong>Pembayaran Otomatis</strong> – Transaksi via Pakasir (QRIS) langsung diproses.</li>
<li>✅ <strong>Aktivasi Instan</strong> – Panel aktif segera setelah pembayaran berhasil.</li>
<li>✅ <strong>Berbagai Pilihan Paket</strong> – RAM dari 1GB hingga 10GB, serta Unlimited.</li>
<li>✅ <strong>Manajemen Panel Mudah</strong> – Lihat detail login, password, dan URL panel di profil.</li>
<li>✅ <strong>Fitur Refund (20 Menit)</strong> – Ajukan pengembalian dana dengan mengisi nomor Dana.</li>
<li>✅ <strong>Keamanan Terjamin</strong> – Data tersimpan di GitHub dengan enkripsi.</li>
</ul>
<p><strong>💡 Cara Pembelian:</strong> Pilih paket, login, lakukan pembayaran, dan panel Anda akan otomatis dibuat. Nikmati kemudahan tanpa ribet!</p>
</div>
<div class="modal-buttons">
<button class="modal-btn cancel" onclick="closeInfoModal()">Tutup</button>
</div>
</div>
</div>
<div id="orderModal" class="modal">
<div class="modal-content">
<h2 id="modalTitle">Konfirmasi Pembelian</h2>
<div id="modalPackageDetails" style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 15px; margin-bottom: 20px; text-align: left;"></div>
<div class="modal-buttons">
<button class="modal-btn cancel" onclick="closeOrderModal()">Batal</button>
<button class="modal-btn confirm" onclick="submitOrder()">Beli Sekarang</button>
</div>
</div>
</div>
<div id="loginModal" class="modal">
<div class="modal-content">
<img src="https://files.catbox.moe/guq9ea.gif" alt="Login reminder" class="modal-gif">
<h2 style="margin-bottom: 15px;">🔐 Perhatian</h2>
<p>Silakan login terlebih dahulu untuk membeli panel.</p>
<div class="modal-buttons">
<button class="modal-btn cancel" onclick="closeLoginModal()">Batal</button>
<button class="modal-btn confirm" onclick="window.location.href='/login'">Lanjutkan</button>
</div>
</div>
</div>
<script>
const isLoggedIn = ${isLoggedIn};
const canvas = document.getElementById('bgCanvas');
const ctx = canvas.getContext('2d');
let width = window.innerWidth, height = window.innerHeight;
function resizeCanvas(){ width=window.innerWidth; height=window.innerHeight; canvas.width=width; canvas.height=height; }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
class Particle{constructor(x,y,size,speedX,speedY,color){this.x=x;this.y=y;this.size=size;this.speedX=speedX;this.speedY=speedY;this.color=color}update(){this.x+=this.speedX;this.y+=this.speedY;if(this.x>width)this.x=0;if(this.x<0)this.x=width;if(this.y>height)this.y=0;if(this.y<0)this.y=height}draw(ctx){ctx.beginPath();ctx.arc(this.x,this.y,this.size,0,Math.PI*2);ctx.fillStyle=this.color;ctx.fill()}}
let particles=[]; const PARTICLE_COUNT=80; const COLORS=['#5b8cff','#3a6df0','#1a4a9f','#5b8cffaa','#3a6df0aa','#7b9cff'];
function initParticles(){particles=[];for(let i=0;i<PARTICLE_COUNT;i++){let size=Math.random()*5+1.5;let x=Math.random()*width;let y=Math.random()*height;let speedX=(Math.random()-0.5)*0.35;let speedY=(Math.random()-0.5)*0.2;let color=COLORS[Math.floor(Math.random()*COLORS.length)];particles.push(new Particle(x,y,size,speedX,speedY,color))}}
function animate(){ctx.clearRect(0,0,width,height);ctx.fillStyle='#03050a';ctx.fillRect(0,0,width,height);let gradient=ctx.createLinearGradient(0,0,width,height);gradient.addColorStop(0,'rgba(3,5,10,0.5)');gradient.addColorStop(1,'rgba(3,5,10,0.8)');ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);particles.forEach(p=>{p.update();p.draw(ctx)});ctx.beginPath();ctx.strokeStyle='rgba(91,140,255,0.2)';ctx.lineWidth=0.8;for(let i=0;i<particles.length;i++){for(let j=i+1;j<particles.length;j++){let dx=particles[i].x-particles[j].x;let dy=particles[i].y-particles[j].y;let dist=Math.sqrt(dx*dx+dy*dy);if(dist<120){ctx.beginPath();ctx.moveTo(particles[i].x,particles[i].y);ctx.lineTo(particles[j].x,particles[j].y);ctx.stroke()}}}requestAnimationFrame(animate)}
initParticles(); animate();
const menuBtn = document.getElementById('menuBtn');
const statusPanel = document.getElementById('statusPanel');
const pageContainer = document.getElementById('pageContainer');
menuBtn.addEventListener('click', () => { menuBtn.classList.toggle('active'); statusPanel.classList.toggle('show'); pageContainer.classList.toggle('blur'); });
const infoBtn = document.getElementById('infoBtn');
const infoModal = document.getElementById('infoModal');
function openInfoModal() {
infoModal.style.display = 'flex';
}
function closeInfoModal() {
infoModal.style.display = 'none';
}
infoBtn.addEventListener('click', openInfoModal);
window.addEventListener('click', (e) => {
if (e.target === infoModal) closeInfoModal();
});
const supportBtn = document.getElementById('supportBtn');
const supportDropdown = document.getElementById('supportDropdown');
if (supportBtn) {
supportBtn.addEventListener('click', (e) => {
e.stopPropagation();
supportDropdown.classList.toggle('show');
});
}
window.addEventListener('click', () => {
if (supportDropdown) supportDropdown.classList.remove('show');
});
if (supportDropdown) {
supportDropdown.addEventListener('click', (e) => e.stopPropagation());
}
const statusContent = document.getElementById('statusContent');
async function loadStatus(){try{const res=await fetch('/api/status');const data=await res.json();const uptime=formatUptime(data.uptime);statusContent.innerHTML=\`<div class="status-item"><div class="label">STATUS</div><div class="value" style="color:#0f0;">🟢 ONLINE</div></div><div class="status-item"><div class="label">VERSION</div><div class="value">\${data.version}</div></div><div class="status-item"><div class="label">DEV</div><div class="value">\${data.developer}</div></div><div class="status-item"><div class="label">UPTIME</div><div class="value">\${uptime}</div></div><div class="status-item"><div class="label">TIME</div><div class="value">\${new Date(data.timestamp).toLocaleTimeString('id-ID')}</div></div>\`;}catch{statusContent.innerHTML='<div class="status-item">❌ Gagal</div>';}}
function formatUptime(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);return \`\${d}d \${h}h \${m}m \${sec}s\`;}
loadStatus(); setInterval(loadStatus,30000);
const MAX_BAR_HEIGHT = 70;
function getColorForHeight(height, maxHeight) {
const ratio = Math.min(1, Math.max(0, height / maxHeight));
const hue = 120 * (1 - ratio);
return \`hsl(\${hue}, 100%, 60%)\`;
}
function generateHeightsAndColors(basePercent, barCount = 24, maxHeight = MAX_BAR_HEIGHT) {
const heights = [];
const colors = [];
for (let i = 0; i < barCount; i++) {
let randomFactor = (Math.random() - 0.5) * 0.3;
let percent = Math.min(100, Math.max(0, basePercent * (1 + randomFactor)));
let height = (percent / 100) * maxHeight;
heights.push(height);
colors.push(getColorForHeight(height, maxHeight));
}
return { heights, colors };
}
function updateBarsWithColor(bars, basePercent) {
if (!bars || bars.length === 0) return;
const { heights, colors } = generateHeightsAndColors(basePercent, bars.length);
bars.forEach((bar, idx) => {
bar.style.height = heights[idx] + 'px';
bar.style.background = colors[idx];
});
}
function initBars(containerId, barCount = 24) {
const container = document.getElementById(containerId);
if (!container) return [];
container.innerHTML = '';
for (let i = 0; i < barCount; i++) {
const bar = document.createElement('div');
bar.className = 'bar';
bar.style.height = '5px';
container.appendChild(bar);
}
return Array.from(container.children);
}
const cpuBars = initBars('cpuBars', 24);
const memBars = initBars('memBars', 24);
const netBars = initBars('netBars', 24);
setInterval(() => {
const cpuPercent = parseFloat(document.getElementById('cpuValue').innerText) || 0;
const memMB = parseFloat(document.getElementById('memValue').innerText) || 0;
const netBps = parseFloat(document.getElementById('netValue').innerText) || 0;
const memPercent = Math.min(100, (memMB / 500) * 100);
const netPercent = Math.min(100, (netBps / 1000) * 100);
updateBarsWithColor(cpuBars, cpuPercent);
updateBarsWithColor(memBars, memPercent);
updateBarsWithColor(netBars, netPercent);
}, 2000);
setInterval(()=>{
document.getElementById('cpuValue').innerText = (Math.random()*30).toFixed(1)+'%';
document.getElementById('memValue').innerText = Math.floor(Math.random()*400)+' MiB';
document.getElementById('netValue').innerText = Math.floor(Math.random()*500)+' B/s';
}, 2000);
let slideIdx=0,slideInt;const slider=document.getElementById('newsSlider'),track=document.querySelector('.slider-track');
function startSlider(){clearInterval(slideInt);slideInt=setInterval(()=>{slideIdx=(slideIdx+1)%2;updateSlide();},5000);}
function updateSlide(){if(track)track.style.transform=\`translateX(-\${slideIdx*50}%)\`;}
function setupSlider(){if(!slider||!track)return;let isSwiping=false,startX=0,curX=0;const getX=e=>e.type.includes('mouse')?e.pageX:e.touches[0].clientX;slider.addEventListener('touchstart',e=>{startX=getX(e);isSwiping=true;clearInterval(slideInt);});slider.addEventListener('touchmove',e=>{if(!isSwiping)return;curX=getX(e);const diff=curX-startX;if(Math.abs(diff)>20)track.style.transform=\`translateX(-\${slideIdx*50+(diff/slider.offsetWidth)*50}%)\`;});slider.addEventListener('touchend',e=>{if(!isSwiping)return;isSwiping=false;const diff=curX-startX;if(Math.abs(diff)>80)diff>0?slideIdx=(slideIdx-1+2)%2:slideIdx=(slideIdx+1)%2;updateSlide();startSlider();});['mousedown','mousemove','mouseup','mouseleave'].forEach(ev=>slider.addEventListener(ev,e=>{e.preventDefault();}));}
startSlider(); setupSlider();
const panelData = [
{ type:'1gb', ram:'1GB', disk:'1GB', cpu:'40%', price:${config.PRICE_1GB || 500} },
{ type:'2gb', ram:'2GB', disk:'2GB', cpu:'60%', price:${config.PRICE_2GB || 500} },
{ type:'3gb', ram:'3GB', disk:'3GB', cpu:'80%', price:${config.PRICE_3GB || 500} },
{ type:'4gb', ram:'4GB', disk:'4GB', cpu:'100%', price:${config.PRICE_4GB || 500} },
{ type:'5gb', ram:'5GB', disk:'5GB', cpu:'120%', price:${config.PRICE_5GB || 500} },
{ type:'6gb', ram:'6GB', disk:'6GB', cpu:'140%', price:${config.PRICE_6GB || 500} },
{ type:'7gb', ram:'7GB', disk:'7GB', cpu:'160%', price:${config.PRICE_7GB || 500} },
{ type:'8gb', ram:'8GB', disk:'8GB', cpu:'180%', price:${config.PRICE_8GB || 500} },
{ type:'9gb', ram:'9GB', disk:'9GB', cpu:'200%', price:${config.PRICE_9GB || 500} },
{ type:'10gb', ram:'10GB', disk:'10GB', cpu:'220%', price:${config.PRICE_10GB || 500} },
{ type:'unli', ram:'Unlimited', disk:'Unlimited', cpu:'Unlimited', price:${config.PRICE_UNLI || 500} }
];
let selectedPanel = null;
function generatePriceCards(){const grid=document.getElementById('pricingGrid');let html='';panelData.forEach(panel=>{html+=\`<div class="price-card"><div class="panel-type">\${panel.type.toUpperCase()}</div><div class="panel-specs"><div><i class="fas fa-memory"></i> RAM: \${panel.ram}</div><div><i class="fas fa-hdd"></i> DISK: \${panel.disk}</div><div><i class="fas fa-microchip"></i> CPU: \${panel.cpu}</div></div><div class="price">Rp \${panel.price.toLocaleString('id-ID')}</div><button class="buy-btn" onclick="openOrderModal('\${panel.type}')"><i class="fas fa-shopping-cart"></i> BELI SEKARANG</button></div>\`;});grid.innerHTML=html;}
function openOrderModal(panelType){
if(!isLoggedIn){
document.getElementById('loginModal').style.display='flex';
return;
}
const panel=panelData.find(p=>p.type===panelType);
if(!panel) return;
selectedPanel=panelType;
document.getElementById('modalPackageDetails').innerHTML=\`<p><strong>📦 Paket:</strong> \${panel.type.toUpperCase()}</p><p><strong>💾 RAM:</strong> \${panel.ram}</p><p><strong>💿 Disk:</strong> \${panel.disk}</p><p><strong>⚙️ CPU:</strong> \${panel.cpu}</p><p><strong>💰 Harga:</strong> Rp \${panel.price.toLocaleString('id-ID')}</p>\`;
document.getElementById('modalTitle').innerHTML=\`Konfirmasi Pembelian - \${panel.type.toUpperCase()}\`;
document.getElementById('orderModal').style.display='flex';
}
function closeOrderModal(){document.getElementById('orderModal').style.display='none';selectedPanel=null;}
function closeLoginModal(){document.getElementById('loginModal').style.display='none';}
async function submitOrder(){
if(!isLoggedIn){
alert('Silakan login terlebih dahulu.');
window.location.href = '/login';
return;
}
if(!selectedPanel){
alert('Pilih paket terlebih dahulu!');
return;
}
const confirmBtn = document.querySelector('.modal-btn.confirm');
const originalText = confirmBtn.innerText;
confirmBtn.innerText = 'Memproses...';
confirmBtn.disabled = true;
try{
const response=await fetch('/api/create-order',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({panel_type:selectedPanel}),
credentials: 'include'
});
const data=await response.json();
if(data.success){
window.location.href=data.payment_url;
} else {
alert(data.message||'Gagal membuat order');
closeOrderModal();
}
}catch(error){
console.error('Error:',error);
alert('Terjadi kesalahan, silahkan coba lagi');
closeOrderModal();
} finally {
confirmBtn.innerText = originalText;
confirmBtn.disabled = false;
}
}
generatePriceCards();
</script>
</body>
</html>
`;
  res.send(html);
});

  // ==========================================================================
  // 404 HANDLER
  // ==========================================================================
  app.use((req, res) => {
    res.status(404).send(`
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=0.60">
<title>404 - Halaman Tidak Ditemukan</title>
<style>
body{background:url('https://files.catbox.moe/u49ezq.jpg') no-repeat center center fixed;background-size:cover;color:#fff;font-family:'Rajdhani',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;text-align:center;margin:0;padding:20px;position:relative;}
body::before{content:'';position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:0;}
.container{max-width:500px;width:100%;position:relative;z-index:1;background:rgba(15,19,32,0.8);backdrop-filter:blur(8px);padding:30px;border-radius:24px;border:1px solid #2a3a60;box-shadow:0 20px 40px rgba(0,0,0,0.8);}
.error-image{width:400px;max-width:90%;height:auto;border-radius:16px;box-shadow:0 0 30px rgba(91,140,255,0.3);margin-bottom:20px;display:block;margin-left:auto;margin-right:auto;}
h1{font-size:72px;color:#5b8cff;margin:0;text-shadow:0 0 20px #5b8cff;line-height:1.2;}
.message{font-size:24px;color:#ccc;margin:10px 0 30px 0;}
a{color:#5b8cff;text-decoration:none;font-weight:bold;font-size:18px;display:inline-block;padding:10px 30px;border:2px solid #5b8cff;border-radius:40px;transition:0.3s;}
a:hover{background:#5b8cff;color:#000;box-shadow:0 0 20px #5b8cff;}
</style>
</head>
<body>
<div class="container">
<img src="https://files.catbox.moe/yfdzzl.gif" alt="404 - Halaman tidak ditemukan" class="error-image">
<div class="message">Halaman tidak ditemukan</div>
<a href="/">Kembali ke Beranda</a>
</div>
</body>
</html>
`);
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
      console.log(`✅ ${toCancel.length} order dibatalkan karena melebihi 2 menit`);
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
  console.log(`GitHub siap: owner=${owner}, repo=${repo}, branch=${GITHUB_BRANCH}, path=${GITHUB_PATH}`);
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