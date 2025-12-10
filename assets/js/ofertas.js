// assets/js/ofertas.js
// Actualizado: oculta productos con status 'suspendido' o 'inactivo'.
// Conserva todas las mejoras previas (scroll-snap, badge "Oferta", modal carrito compatible, sliders).
//
// Nota: este archivo reemplaza la versión anterior de assets/js/ofertas.js

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getFirestore, collection, getDocs, doc, getDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ---------- Cart cookie helpers (compatibles con pedidos-data.js) ---------- */
function setCookieJSON(name, value, days = 14) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(JSON.stringify(value))}; expires=${expires}; path=/; samesite=strict`;
}
function getCookieJSON(name) {
  const cookies = document.cookie ? document.cookie.split('; ') : [];
  for (const c of cookies) {
    const [k, v] = c.split('=');
    if (decodeURIComponent(k) === name) {
      try { return JSON.parse(decodeURIComponent(v)); } catch (err) { return null; }
    }
  }
  return null;
}
function generateCartToken() {
  const rnds = crypto.getRandomValues(new Uint8Array(16));
  const toHex = (b) => b.toString(16).padStart(2, '0');
  return [...rnds].map(toHex).join('');
}
const CART_COOKIE = 'mi_tienda_cart_v1';
let CART = null;

function createEmptyCart() { return { cartToken: generateCartToken(), items: [], total: 0, timestamp: new Date().toISOString() }; }
function loadCartFromCookie() {
  const c = getCookieJSON(CART_COOKIE);
  if (!c || !c.cartToken || !Array.isArray(c.items)) { CART = createEmptyCart(); persistCart(); return; }
  CART = c; recalcCart(); persistCart();
}
function persistCart() { setCookieJSON(CART_COOKIE, CART, 14); renderCartCount(); }
function recalcCart() { let total = 0; CART.items.forEach(it => { it.subtotal = it.quantity * it.price; total += it.subtotal; }); CART.total = total; CART.timestamp = new Date().toISOString(); }
function addToCartLocal(product, qty = 1) {
  const existing = CART.items.find(i => i.productId === product.id);
  const price = (product.discountPrice && product.discountPrice > 0) ? Number(product.discountPrice) : Number(product.price || 0);
  if (existing) existing.quantity = Math.min(999, existing.quantity + qty);
  else CART.items.push({ productId: product.id, name: product.name, price, quantity: qty, subtotal: price * qty, image: (product.image || '') });
  recalcCart(); persistCart(); showToast('Artículo agregado al carrito');
}

/* ---------- Toast ---------- */
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, ms = 2400) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------- Firestore fetch & normalization ---------- */
function normalizeProductDoc(snap) {
  const d = snap.data();
  const price = Number(d.price || 0);
  const images = Array.isArray(d.imageUrls) && d.imageUrls.length ? d.imageUrls : (d.imageUrl ? [d.imageUrl] : (d.image ? [d.image] : []));
  const discountPrice = (d.discountPrice !== undefined && d.discountPrice !== null) ? Number(d.discountPrice) : (d.discount ? Math.max(0, price - Number(d.discount)) : null);
  return {
    id: snap.id,
    name: d.name || d.title || '',
    price,
    discountPrice: (discountPrice && discountPrice > 0) ? discountPrice : null,
    images,
    image: images[0] || '',
    description: d.description || '',
    category: d.category || '',
    onOffer: !!d.onOffer,
    status: (d.status || 'Activo'),
    raw: d
  };
}

async function fetchAllProducts() {
  try {
    const col = collection(db, 'product');
    const q = query(col, orderBy('name', 'asc'));
    const snap = await getDocs(q);
    return snap.docs.map(normalizeProductDoc);
  } catch (err) {
    console.error('Error fetching products', err);
    return [];
  }
}

/* ---------- Utils ---------- */
function formatCurrency(n) {
  try { return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n); }
  catch (e) { return `$${n}`; }
}
function escapeHtml(s) { if (!s) return ''; return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]); }

/* ---------- Banner (unchanged) ---------- */
const BANNERS = [
  { title: 'Primavera — 30% OFF', subtitle: 'Descubre nuestras ofertas seleccionadas', img: 'assets/images/banner1.jpg' },
  { title: 'Envío gratis', subtitle: 'En compras sobre $50.000', img: 'assets/images/banner2.jpg' },
  { title: 'Nuevos productos', subtitle: 'Lo último en tecnología y hogar', img: 'assets/images/banner3.jpg' }
];
function renderBanner() {
  const track = document.getElementById('bannerTrack'); if (!track) return;
  track.innerHTML = '';
  BANNERS.forEach(b => {
    const slide = document.createElement('div'); slide.className = 'banner-slide';
    slide.innerHTML = `<div class="banner-content"><h1>${escapeHtml(b.title)}</h1><p>${escapeHtml(b.subtitle)}</p></div><img src="${escapeHtml(b.img)}" alt="${escapeHtml(b.title)}">`;
    track.appendChild(slide);
  });
  let idx = 0;
  function update() {
    const slides = track.querySelectorAll('.banner-slide');
    if (!slides.length) return;
    const width = track.parentElement.clientWidth;
    track.style.transform = `translateX(${-idx * (width + 12)}px)`;
  }
  function next() { idx = (idx + 1) % BANNERS.length; update(); }
  function prev() { idx = (idx - 1 + BANNERS.length) % BANNERS.length; update(); }
  document.getElementById('bannerPrev')?.addEventListener('click', prev);
  document.getElementById('bannerNext')?.addEventListener('click', next);
  let timer = setInterval(next, 4500);
  track.parentElement?.addEventListener('mouseenter', () => clearInterval(timer));
  track.parentElement?.addEventListener('mouseleave', () => timer = setInterval(next, 4500));
  window.addEventListener('resize', update);
  setTimeout(update, 60);
}

/* ---------- Card slider ---------- */
function initCardSlider(cardEl, images = []) {
  const slider = cardEl.querySelector('.card-slider'); if (!slider) return;
  slider.innerHTML = '';
  images.forEach((src, i) => {
    const img = document.createElement('img'); img.src = src; img.alt = `Imagen ${i+1}`; img.style.opacity = i===0? '1':'0'; slider.appendChild(img);
  });
  if (images.length <= 1) return;
  let idx = 0; const imgs = Array.from(slider.querySelectorAll('img'));
  setInterval(() => { const prev = idx; idx = (idx + 1) % imgs.length; imgs[prev].style.opacity = '0'; imgs[idx].style.opacity = '1'; }, 2200);
}

/* ---------- Product card (with offer badge and price formatting) ---------- */
function createProductCard(p) {
  const card = document.createElement('article'); card.className = 'product-card';
  const isOffer = !!(p.onOffer || (p.discountPrice && p.discountPrice < p.price));
  const priceHtml = isOffer
    ? `<span class="old">${formatCurrency(p.price)}</span><span class="current">${formatCurrency(p.discountPrice)}</span>`
    : `<span class="current">${formatCurrency(p.price)}</span>`;
  card.innerHTML = `
    ${isOffer ? `<div class="offer-badge" aria-hidden="true">Oferta</div>` : ''}
    <div class="card-slider" aria-hidden="false"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}"></div>
    <div class="info">
      <h3 class="product-title">${escapeHtml(p.name)}</h3>
      <div class="product-meta">${escapeHtml(p.category || '')}</div>
      <div class="product-price">${priceHtml}</div>
    </div>
    <div class="controls" role="group" aria-label="Controles del producto">
      <button class="button btn-primary add-btn" title="Agregar al carrito" data-id="${escapeHtml(p.id)}" aria-label="Agregar al carrito">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1h1l1 9h10l1-6H4"></path><circle cx="6" cy="13" r="1"></circle><circle cx="12" cy="13" r="1"></circle></svg>
      </button>
      <button class="button btn-secondary copy-link" title="Copiar enlace" data-id="${escapeHtml(p.id)}" aria-label="Copiar enlace">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1 1 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4 4 0 0 1-.128-1.287z"/></svg>
      </button>
    </div>
  `;
  return card;
}

/* ---------- Copy link ---------- */
function buildAddLink(productId) {
  const origin = window.location.origin;
  return `${origin}/tiendita.com/carrito.html?add=${encodeURIComponent(productId)}&openCart=1`;
}
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    showToast('Enlace copiado al portapapeles');
  } catch (err) { console.error('copy failed', err); showToast('No se pudo copiar el enlace'); }
}

/* ---------- Helper: check product visibility by status ---------- */
function isProductVisible(p) {
  if (!p || !p.status) return true;
  const s = String(p.status).toLowerCase().trim();
  return !(s === 'suspendido' || s === 'suspended' || s === 'inactivo' || s === 'inactive');
}

/* ---------- Render lists (HIDE suspended/inactivo) ---------- */
function renderProductsLists(products) {
  const offersGrid = document.getElementById('offersGrid'); const productsGrid = document.getElementById('productsGrid');
  if (!offersGrid || !productsGrid) return;
  offersGrid.innerHTML = ''; productsGrid.innerHTML = '';

  // Filter out suspended/inactivo products
  const visibleProducts = products.filter(isProductVisible);

  const offers = visibleProducts.filter(p => p.onOffer || (p.discountPrice && p.discountPrice < p.price));
  offers.slice(0,6).forEach(p => { const card = createProductCard(p); offersGrid.appendChild(card); if (p.images && p.images.length>1) initCardSlider(card, p.images); });
  visibleProducts.forEach(p => { const card = createProductCard(p); productsGrid.appendChild(card); if (p.images && p.images.length>1) initCardSlider(card, p.images); });

  document.querySelectorAll('.add-btn').forEach(btn => btn.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.id; const prod = visibleProducts.find(x => x.id === id); if (!prod) { showToast('Producto no disponible'); return; }
    addToCartLocal(prod, 1); updateNavCounts();
  }));
  document.querySelectorAll('.copy-link').forEach(btn => btn.addEventListener('click', async (e) => {
    const id = e.currentTarget.dataset.id; const link = buildAddLink(id); await copyToClipboard(link);
  }));
}

/* ---------- Nav/cart count ---------- */
function renderCartCount() { const count = CART.items.reduce((s, it) => s + it.quantity, 0); const el = document.getElementById('fabCount'); const nav = document.getElementById('navCartCount'); if (el) el.textContent = count; if (nav) nav.textContent = count; }
function updateNavCounts() { renderCartCount(); }

/* ---------- Header sizing & avoidance of overlap ---------- */
function updateHeaderHeightVar() {
  const header = document.querySelector('.site-header');
  const height = header ? header.getBoundingClientRect().height : 72;
  document.documentElement.style.setProperty('--header-height', `${Math.ceil(height)}px`);
  document.documentElement.style.scrollPaddingTop = `calc(${Math.ceil(height)}px + 12px)`;
}
window.addEventListener('resize', updateHeaderHeightVar);

/* ---------- Boot ---------- */
async function boot() {
  // ensure cart cookie + state
  loadCartFromCookie();

  // update header sizing for scroll-padding
  updateHeaderHeightVar();

  // render banner
  renderBanner();

  // fetch products
  const products = await fetchAllProducts();

  // render lists (hidden suspended/inactivo)
  renderProductsLists(products);

  // attach floating cart behavior (open carrito page or modal if present)
  const fab = document.getElementById('openCartBtn');
  if (fab) fab.addEventListener('click', () => {
    const modal = document.getElementById('cartModal');
    if (modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false'); renderCartModal(); }
    else window.location.href = 'carrito.html';
  });

  // update nav counts
  updateNavCounts();

  // handle URL params if any (add to cart)
  const params = new URLSearchParams(window.location.search);
  const addParam = params.get('add'); const openCart = params.get('openCart');
  if (addParam) {
    const prod = products.find(p => p.id === addParam);
    if (prod && isProductVisible(prod)) { addToCartLocal(prod, 1); updateNavCounts(); if (openCart) { setTimeout(()=>{ const modal = document.getElementById('cartModal'); if (modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false'); renderCartModal(); } else window.location.href = 'carrito.html'; }, 120); } }
  }
}

/* helper: fetchProductById fallback (minimal) */
async function fetchProductById(id) {
  try { const docRef = doc(db, 'product', id); const snap = await getDoc(docRef); if (snap.exists()) return normalizeProductDoc(snap); } catch(e){/*ignore*/} return null;
}

/* Start */
window.addEventListener('load', () => { boot().catch(err => console.error('boot error', err)); updateHeaderHeightVar(); });