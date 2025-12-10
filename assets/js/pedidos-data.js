// pedidos-data.js completo y actualizado
// - Carrito inline (minimizable), checkout inline
// - Formulario validado en tiempo real (email, teléfono solo números, requerido)
// - Mejora en modales y accesibilidad
// - Eliminado botón "copiar enlace"
// - Prevención de double submit
// - Resolución de imágenes desde Firebase Storage y resto de funcionalidades previas

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore, collection, getDocs, getDoc, doc, addDoc, serverTimestamp, query, orderBy, where, limit
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getStorage, ref as storageRef, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

/* ----------------------
   Inicializa Firebase
   ---------------------- */
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

/* ----------------------
   Helpers cookies/cart
   ---------------------- */
function generateCartToken() {
    const rnds = crypto.getRandomValues(new Uint8Array(16));
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;
    const toHex = (b) => b.toString(16).padStart(2, '0');
    const uuid = [...rnds].map(toHex).join('');
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}
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

/* ----------------------
   Cart structure
   ---------------------- */
const CART_COOKIE = 'mi_tienda_cart_v1';
let CART = null;
function createEmptyCart() {
    const token = generateCartToken();
    return { cartToken: token, items: [], total: 0, timestamp: new Date().toISOString() };
}
function loadCartFromCookie() {
    const c = getCookieJSON(CART_COOKIE);
    if (!c) { CART = createEmptyCart(); persistCart(); return; }
    if (!c.cartToken || !Array.isArray(c.items)) { CART = createEmptyCart(); persistCart(); return; }
    CART = c;
    recalcCart();
}
function persistCart() { setCookieJSON(CART_COOKIE, CART, 14); renderCartCount(); }
function recalcCart() {
    let total = 0;
    CART.items.forEach(it => { it.subtotal = it.quantity * it.price; total += it.subtotal; });
    CART.total = total;
    CART.timestamp = new Date().toISOString();
}

/* ----------------------
   Productos: fetch + normalize
   ---------------------- */
let PRODUCTS = [];
let PRODUCTS_BY_ID = new Map();
function normalizeProduct(doc) {
    const data = doc.data();
    const price = Number(data.price) || 0;
    const discountPrice = (data.discountPrice !== undefined && data.discountPrice !== null)
        ? Number(data.discountPrice)
        : (data.discount ? Math.max(0, price - Number(data.discount)) : null);
    const isOnSale = !!(data.onOffer || data.isOnSale || data.onoffer || (discountPrice && discountPrice < price));
    const images = Array.isArray(data.imageUrls) && data.imageUrls.length ? data.imageUrls.slice()
        : (data.imageUrl ? [data.imageUrl] : (data.image ? [data.image] : (Array.isArray(data.imagePaths) ? data.imagePaths.slice() : [])));
    return {
        id: doc.id,
        name: data.name || data.title || '',
        price,
        discountPrice: (discountPrice && discountPrice > 0) ? discountPrice : null,
        isOnSale,
        images,
        image: images && images.length ? images[0] : '',
        description: data.description || '',
        category: data.category || '',
        slug: data.slug || '',
        status: data.status || 'Activo',
        stock: (typeof data.stock !== 'undefined') ? Number(data.stock) : null,
        raw: data
    };
}
async function fetchAllProductsFromFirestore() {
    try {
        const col = collection(db, 'product');
        const q = query(col, orderBy('name', 'asc'));
        const snap = await getDocs(q);
        const arr = snap.docs.map(normalizeProduct);
        PRODUCTS = arr;
        PRODUCTS_BY_ID = new Map(arr.map(p => [p.id, p]));
        for (const p of arr) {
            if (p.slug) PRODUCTS_BY_ID.set(p.slug, p);
            const nlower = (p.name || '').toLowerCase();
            if (nlower) PRODUCTS_BY_ID.set(nlower, p);
        }
        return arr;
    } catch (err) {
        console.error('Error cargando products desde Firestore:', err);
        throw err;
    }
}
async function fetchProductByIdOrSlug(param) {
    if (PRODUCTS_BY_ID.has(param)) return PRODUCTS_BY_ID.get(param);
    try {
        const docRef = doc(db, 'product', param);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            const p = normalizeProduct(snap);
            PRODUCTS.push(p);
            PRODUCTS_BY_ID.set(p.id, p);
            if (p.slug) PRODUCTS_BY_ID.set(p.slug, p);
            PRODUCTS_BY_ID.set((p.name || '').toLowerCase(), p);
            return p;
        }
    } catch (err) { console.error('Error buscando product por id:', err); }
    try {
        const col = collection(db, 'product');
        const q = query(col, where('slug', '==', param), limit(1));
        const snap = await getDocs(q);
        if (!snap.empty) {
            const p = normalizeProduct(snap.docs[0]);
            PRODUCTS.push(p);
            PRODUCTS_BY_ID.set(p.id, p);
            if (p.slug) PRODUCTS_BY_ID.set(p.slug, p);
            PRODUCTS_BY_ID.set((p.name || '').toLowerCase(), p);
            return p;
        }
    } catch (err) { console.error('Error buscando product por slug:', err); }
    return null;
}

/* ----------------------
   Storage resolver (caching)
   ---------------------- */
const _resolvedImageCache = new Map();
async function resolveImagePath(pathOrUrl) {
    if (!pathOrUrl) return null;
    if (_resolvedImageCache.has(pathOrUrl)) return _resolvedImageCache.get(pathOrUrl);
    if (/^https?:\/\//i.test(pathOrUrl)) { _resolvedImageCache.set(pathOrUrl, pathOrUrl); return pathOrUrl; }
    try {
        const ref = storageRef(storage, pathOrUrl);
        const url = await getDownloadURL(ref);
        _resolvedImageCache.set(pathOrUrl, url);
        return url;
    } catch (err) {
        console.warn('No se pudo resolver storage path:', pathOrUrl, err);
        _resolvedImageCache.set(pathOrUrl, null);
        return null;
    }
}
async function resolveProductImages(product) {
    if (!product) return [];
    if (product.__resolvedImages) return product.__resolvedImages;
    const imgs = Array.isArray(product.images) ? product.images : (product.image ? [product.image] : []);
    const promises = imgs.map(p => resolveImagePath(p));
    const urls = (await Promise.all(promises)).filter(Boolean);
    product.__resolvedImages = urls;
    if (!product.image && urls.length) product.image = urls[0];
    return urls;
}

/* ----------------------
   Utilidades UI
   ---------------------- */
function formatCurrency(n) {
    try {
        return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n);
    } catch (err) { return `$${n}`; }
}
function isProductVisible(p) {
    if (!p || !p.status) return true;
    const s = String(p.status).toLowerCase().trim();
    return !(s === 'suspendido' || s === 'suspended' || s === 'inactivo' || s === 'inactive');
}
const toastEl = document.getElementById('toast');
let toastTimeout = null;
function showToast(msg, ms = 2200) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

/* ----------------------
   Operaciones sobre carrito
   ---------------------- */
function addToCart(productIdOrSlug, qty = 1) {
    const p = PRODUCTS_BY_ID.get(productIdOrSlug);
    if (!p) { showToast('Producto no encontrado. Recarga la página.'); return false; }
    if (!isProductVisible(p)) { showToast('Producto no disponible'); return false; }
    if (typeof p.stock === 'number' && p.stock <= 0) { showToast('Producto sin stock'); return false; }
    const price = (p.discountPrice && Number(p.discountPrice) > 0) ? Number(p.discountPrice) : Number(p.price);
    const existing = CART.items.find(i => i.productId === p.id);
    if (existing) { existing.quantity = Math.min(999, existing.quantity + qty); }
    else {
        CART.items.push({ productId: p.id, name: p.name, price, quantity: Math.max(1, Math.min(999, qty)), subtotal: price * qty, image: (p.image || (p.__resolvedImages && p.__resolvedImages[0]) || '') });
    }
    recalcCart(); persistCart(); showToast('Producto agregado al carrito'); return true;
}
function updateQuantity(productId, qty) {
    const item = CART.items.find(i => i.productId === productId);
    if (!item) return;
    const q = Math.max(0, Math.min(999, Math.floor(qty)));
    if (q === 0) { removeItem(productId); return; }
    item.quantity = q; recalcCart(); persistCart();
}
function removeItem(productId) {
    CART.items = CART.items.filter(i => i.productId !== productId); recalcCart(); persistCart();
}
function clearCart() { CART = createEmptyCart(); persistCart(); showToast('Carrito vaciado'); }

/* ----------------------
   Confirm modal (mejor estilo) - retorna Promise<boolean>
   ---------------------- */
function showConfirm(message = '¿Estás seguro?') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const msg = document.getElementById('confirmMessage');
        const btnAccept = document.getElementById('confirmAccept');
        const btnCancel = document.getElementById('confirmCancel');
        if (!modal || !msg || !btnAccept || !btnCancel) {
            const r = window.confirm(message);
            return resolve(r);
        }
        msg.textContent = message;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        btnAccept.focus();

        function cleanup() {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
            btnAccept.removeEventListener('click', onAccept);
            btnCancel.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
        }
        function onAccept() { cleanup(); resolve(true); }
        function onCancel() { cleanup(); resolve(false); }
        function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(false); } }

        btnAccept.addEventListener('click', onAccept);
        btnCancel.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
}

/* ----------------------
   Render carrito inline
   ---------------------- */
let SELECTED_PRODUCT_ID = null;
function renderCartCount() {
    const count = CART.items.reduce((s, i) => s + i.quantity, 0);
    const c1 = document.getElementById('cartCount');
    if (c1) c1.textContent = count;
}

function renderCartPanel() {
    const selectedEl = document.getElementById('selectedProducts');
    const availableEl = document.getElementById('availableProducts');
    const subtotalEl = document.getElementById('cartSubtotalInline');
    const totalEl = document.getElementById('cartTotalInline');
    const checkoutTotalHeader = document.getElementById('checkoutTotalHeader');
    if (!selectedEl || !availableEl) return;

    const items = CART.items.slice().filter(i => i.quantity > 0);
    items.sort((a, b) => {
        if (a.productId === SELECTED_PRODUCT_ID) return -1;
        if (b.productId === SELECTED_PRODUCT_ID) return 1;
        return 0;
    });

    selectedEl.innerHTML = '';
    if (!items.length) {
        selectedEl.innerHTML = '<div style="padding:12px;color:#64748b">No hay artículos seleccionados.</div>';
    } else {
        for (const it of items) {
            const div = document.createElement('div');
            div.className = 'cart-item';
            div.innerHTML = `
              <img src="${escapeHtml(it.image || '')}" alt="${escapeHtml(it.name)}">
              <div style="flex:1">
                <div style="font-weight:700">${escapeHtml(it.name)}</div>
                <div style="color:#94a3b8">${formatCurrency(it.price)} x ${it.quantity} = <strong>${formatCurrency(it.subtotal)}</strong></div>
                <div style="margin-top:8px" class="qty-controls">
                  <button class="qty-decr" data-id="${it.productId}" aria-label="Disminuir">−</button>
                  <input class="qty-input" data-id="${it.productId}" type="number" min="0" max="999" value="${it.quantity}" style="width:60px;padding:6px;border-radius:8px;border:1px solid #e6eef6">
                  <button class="qty-incr" data-id="${it.productId}" aria-label="Aumentar">+</button>
                  <button class="btn-secondary remove-item" data-id="${it.productId}" style="margin-left:8px">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
                        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                        <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                    </svg>
                  </button>
                </div>
              </div>
            `;
            selectedEl.appendChild(div);
        }

        // controls
        selectedEl.querySelectorAll('.qty-incr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const item = CART.items.find(x => x.productId === id);
                if (!item) return;
                updateQuantity(id, item.quantity + 1);
                renderCartPanel();
            });
        });
        selectedEl.querySelectorAll('.qty-decr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const item = CART.items.find(x => x.productId === id);
                if (!item) return;
                updateQuantity(id, Math.max(0, item.quantity - 1));
                renderCartPanel();
            });
        });
        selectedEl.querySelectorAll('.qty-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.currentTarget.dataset.id;
                let q = parseInt(e.currentTarget.value, 10);
                if (isNaN(q) || q < 0) q = 0;
                updateQuantity(id, q);
                renderCartPanel();
            });
        });
        selectedEl.querySelectorAll('.remove-item').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                const ok = await showConfirm('Eliminar artículo del carrito?');
                if (!ok) return;
                removeItem(id);
                renderCartPanel();
            });
        });
    }

    // Available products
    const inCartIds = new Set(CART.items.map(i => i.productId));
    const availProducts = PRODUCTS.filter(p => isProductVisible(p) && (typeof p.stock !== 'number' || p.stock > 0) && !inCartIds.has(p.id));
    availableEl.innerHTML = '';
    if (!availProducts.length) {
        availableEl.innerHTML = '<div style="padding:12px;color:#64748b">No hay productos disponibles.</div>';
    } else {
        for (const p of availProducts) {
            const resolved = (p.__resolvedImages && p.__resolvedImages[0]) || p.image || '';
            const div = document.createElement('div');
            div.className = 'avail-item';
            div.innerHTML = `
              <img src="${escapeHtml(resolved)}" alt="${escapeHtml(p.name)}">
              <div style="flex:1">
                <div style="font-weight:700">${escapeHtml(p.name)}</div>
                <div style="color:#94a3b8">${p.discountPrice ? `<span class="old">${formatCurrency(p.price)}</span> <strong>${formatCurrency(p.discountPrice)}</strong>` : `<strong>${formatCurrency(p.price)}</strong>`}</div>
                <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
                  <div class="qty-controls" style="align-items:center">
                    <button class="qty-decr avail-decr" data-id="${escapeHtml(p.id)}" aria-label="Disminuir">−</button>
                    <input class="avail-qty qty-input" data-id="${escapeHtml(p.id)}" type="number" min="0" max="999" value="0" style="width:70px;padding:6px;border-radius:8px;border:1px solid #e6eef6">
                    <button class="qty-incr avail-incr" data-id="${escapeHtml(p.id)}" aria-label="Aumentar">+</button>
                  </div>

                </div>
              </div>
            `;
            availableEl.appendChild(div);
        }

        // listeners: add on qty change and buttons
        availableEl.querySelectorAll('.avail-qty').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.currentTarget.dataset.id;
                let q = parseInt(e.currentTarget.value, 10);
                if (isNaN(q) || q < 0) q = 0;
                if (q === 0) { e.currentTarget.value = 0; return; }
                const added = addToCart(id, q);
                if (added) { renderCartPanel(); e.currentTarget.value = 0; }
                else { e.currentTarget.value = 0; }
            });
        });

        // plus: add one to cart immediately
        availableEl.querySelectorAll('.avail-incr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                addToCart(id, 1);
                renderCartPanel();
            });
        });

        // minus: if item exists in cart, decrement one
        availableEl.querySelectorAll('.avail-decr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const item = CART.items.find(x => x.productId === id);
                if (!item) { showToast('No hay unidades en el carrito para este producto'); return; }
                updateQuantity(id, Math.max(0, item.quantity - 1));
                renderCartPanel();
            });
        });

        // Add button: read qty input (if 0 or empty -> add 1)
        availableEl.querySelectorAll('.add-avail').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const input = availableEl.querySelector(`.avail-qty[data-id="${id}"]`);
                let q = 1;
                if (input) {
                    const v = parseInt(input.value, 10);
                    if (!isNaN(v) && v > 0) q = v;
                }
                const added = addToCart(id, q);
                if (added) {
                    renderCartPanel();
                    if (input) input.value = 0;
                }
            });
        });
    }

    // Totales
    const subtotal = CART.total || 0;
    subtotalEl.textContent = formatCurrency(subtotal);
    totalEl.textContent = formatCurrency(subtotal);
    if (checkoutTotalHeader) checkoutTotalHeader.textContent = `Total: ${formatCurrency(subtotal)}`;

    renderCartCount();
}

/* ----------------------
   Product cards + carousel
   ---------------------- */
function createProductCardHtml(p, resolvedImages = []) {
    const isOffer = !!(p.isOnSale || (p.discountPrice && p.discountPrice < p.price));
    const priceHtml = isOffer
        ? `<span class="old" aria-hidden="true">${formatCurrency(p.price)}</span><span class="current">${formatCurrency(p.discountPrice)}</span>`
        : `<span class="current">${formatCurrency(p.price)}</span>`;
    const sliderHtml = `<div class="card-slider" role="img" aria-label="${escapeHtml(p.name)}">${resolvedImages.length ? resolvedImages.map((u, i) => `<img src="${escapeHtml(u)}" alt="${escapeHtml(p.name)} ${i + 1}" style="opacity:${i === 0 ? 1 : 0}">`).join('') : `<img src="${escapeHtml(p.image || '')}" alt="${escapeHtml(p.name)}">`}</div>`;
    return `
      ${isOffer ? `<div class="offer-badge" aria-hidden="true">Oferta</div>` : ''}
      ${sliderHtml}
      <div class="product-info">
        <div class="product-title">${escapeHtml(p.name)}</div>
        <div class="product-meta">${escapeHtml(p.category || '')}</div>
        <div class="product-price">${priceHtml}</div>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
          <a href="product.html?product=${encodeURIComponent(p.id)}" class="btn-secondary" style="margin-right:8px" aria-label="Ver producto ${escapeHtml(p.name)}">Ver</a>
          <button class="btn-primary add-btn" data-id="${escapeHtml(p.id)}" aria-label="Agregar ${escapeHtml(p.name)}">Agregar</button>
        </div>
      </div>
    `;
}
function initCardSliderDOM(cardEl) {
    const imgs = Array.from(cardEl.querySelectorAll('.card-slider img'));
    if (!imgs.length) return;
    if (imgs.length <= 1) return;
    let idx = 0;
    setInterval(() => {
        const prev = idx;
        idx = (idx + 1) % imgs.length;
        imgs[prev].style.opacity = '0';
        imgs[idx].style.opacity = '1';
    }, 2400);
}
async function renderProductsGrid() {
    const el = document.getElementById('productsGrid');
    if (!el) return;
    el.innerHTML = '';
    const visibleProducts = PRODUCTS.filter(isProductVisible);
    if (!visibleProducts.length) { el.innerHTML = '<div class="spinner">No hay productos para mostrar.</div>'; return; }
    await Promise.all(visibleProducts.map(async (p) => { try { await resolveProductImages(p); } catch (err) { console.warn('Error resolving images for', p.id, err); } }));
    for (const p of visibleProducts) {
        const resolved = p.__resolvedImages && p.__resolvedImages.length ? p.__resolvedImages : (p.image ? [p.image] : []);
        const card = document.createElement('article');
        card.className = 'product-card';
        card.innerHTML = createProductCardHtml(p, resolved);
        el.appendChild(card);
        initCardSliderDOM(card);
    }
    el.querySelectorAll('.add-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const p = PRODUCTS_BY_ID.get(id);
            if (!p || !isProductVisible(p)) { showToast('Producto no disponible'); return; }
            addToCart(id, 1);
            renderCartPanel();
        });
    });
}

/* Carousel */
async function setupCarousel() {
    const track = document.getElementById('carouselTrack');
    const indicators = document.getElementById('carouselIndicators');
    const prev = document.getElementById('carouselPrev');
    const next = document.getElementById('carouselNext');
    if (!track) return;
    const slides = PRODUCTS.filter(p => isProductVisible(p) && (p.isOnSale || (p.discountPrice && Number(p.discountPrice) < Number(p.price))));
    if (!slides.length) { track.innerHTML = '<div style="padding:12px">No hay ofertas disponibles.</div>'; if (indicators) indicators.innerHTML = ''; return; }
    await Promise.all(slides.map(p => resolveProductImages(p)));
    track.innerHTML = '';
    if (indicators) indicators.innerHTML = '';
    slides.forEach((s, idx) => {
        const imgUrl = (s.__resolvedImages && s.__resolvedImages[0]) || s.image || '';
        const isOffer = !!(s.isOnSale || (s.discountPrice && s.discountPrice < s.price));
        const priceHtml = isOffer ? `<span class="old">${formatCurrency(s.price)}</span><span class="current">${formatCurrency(s.discountPrice)}</span>` : `<span class="current">${formatCurrency(s.price)}</span>`;
        const slide = document.createElement('div');
        slide.className = 'carousel-slide';
        slide.innerHTML = `
          ${isOffer ? `<div class="offer-badge">Oferta</div>` : ''}
          <div class="card-slider" aria-hidden="false">
            <img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(s.name)} 1">
            ${(s.__resolvedImages && s.__resolvedImages.length > 1) ? s.__resolvedImages.slice(1).map((u, i) => `<img src="${escapeHtml(u)}" alt="${escapeHtml(s.name)} ${i + 2}" style="opacity:0">`).join('') : ''}
          </div>
          <div class="carousel-info">
            <div class="product-title">${escapeHtml(s.name)}</div>
            <div class="product-meta">${escapeHtml(s.category || '')}</div>
            <div class="product-price">${priceHtml}</div>
            <div class="carousel-controls">
              <button class="btn-primary add-btn" data-id="${escapeHtml(s.id)}" aria-label="Agregar ${escapeHtml(s.name)}">Agregar</button>
              <a class="btn-secondary" href="product.html?product=${encodeURIComponent(s.id)}" aria-label="Ver ${escapeHtml(s.name)}">Ver</a>
            </div>
          </div>
        `;
        track.appendChild(slide);
        if (indicators) {
            const ind = document.createElement('button');
            ind.className = 'indicator';
            ind.dataset.index = idx;
            ind.addEventListener('click', () => { goToSlide(idx); });
            indicators.appendChild(ind);
        }
    });

    document.querySelectorAll('.carousel-slide .card-slider').forEach(slider => {
        const imgs = Array.from(slider.querySelectorAll('img'));
        if (imgs.length <= 1) return;
        let idx = 0;
        setInterval(() => {
            const prev = idx;
            idx = (idx + 1) % imgs.length;
            imgs[prev].style.opacity = '0';
            imgs[idx].style.opacity = '1';
        }, 2400);
    });

    track.querySelectorAll('.add-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            addToCart(id, 1);
            renderCartPanel();
        });
    });

    let carouselIndex = 0;
    let carouselTimer = null;
    function update() {
        const slideEl = track.querySelector('.carousel-slide');
        if (!slideEl) return;
        const style = getComputedStyle(track);
        const gapPx = parseFloat(style.gap || 16);
        const slideWidth = slideEl.clientWidth + gapPx;
        const offset = -carouselIndex * slideWidth;
        track.style.transform = `translateX(${offset}px)`;
        if (indicators) Array.from(indicators.children).forEach((el, i) => el.classList.toggle('active', i === carouselIndex));
    }
    function prevSlide() { carouselIndex = Math.max(0, carouselIndex - 1); update(); }
    function nextSlide() { carouselIndex = Math.min(Math.max(0, slides.length - 1), carouselIndex + 1); update(); }
    function goToSlide(i) { carouselIndex = Math.max(0, Math.min(slides.length - 1, i)); update(); }
    window.goToSlide = goToSlide;
    prev?.addEventListener('click', prevSlide);
    next?.addEventListener('click', nextSlide);
    function startAuto() { stopAuto(); carouselTimer = setInterval(() => { carouselIndex = (carouselIndex + 1) % slides.length; update(); }, 3600); }
    function stopAuto() { if (carouselTimer) clearInterval(carouselTimer); carouselTimer = null; }
    track.parentElement?.addEventListener('mouseenter', stopAuto);
    track.parentElement?.addEventListener('mouseleave', startAuto);

    let startX = 0, deltaX = 0, isDown = false;
    track.addEventListener('pointerdown', (e) => { isDown = true; startX = e.clientX; stopAuto(); });
    window.addEventListener('pointermove', (e) => { if (!isDown) return; deltaX = e.clientX - startX; });
    window.addEventListener('pointerup', () => {
        if (!isDown) return;
        isDown = false;
        if (Math.abs(deltaX) > 40) { if (deltaX < 0) nextSlide(); else prevSlide(); }
        deltaX = 0; startAuto();
    });

    update(); startAuto();
}

/* ----------------------
   URL-handling
   ---------------------- */
async function handleUrlAddParams() {
    const params = new URLSearchParams(window.location.search);
    const addParam = params.get('add');
    const openCart = params.get('openCart');
    const hideProducts = params.get('hideProducts');
    if (!addParam && !hideProducts && !openCart) return;

    const waitFor = (selector, timeout = 2000) => new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const obs = new MutationObserver(() => {
            const found = document.querySelector(selector);
            if (found) { obs.disconnect(); resolve(found); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(document.querySelector(selector)); }, timeout);
    });

    let added = false;
    if (addParam) {
        if (!PRODUCTS_BY_ID.size) {
            try {
                const p = await fetchProductByIdOrSlug(addParam);
                if (p && isProductVisible(p)) { added = addToCart(p.id, 1); if (added) SELECTED_PRODUCT_ID = p.id; }
            } catch (e) { console.warn('Error fetchProductByIdOrSlug', e); }
        } else {
            added = addToCart(addParam, 1);
            if (!added) {
                try {
                    const p = await fetchProductByIdOrSlug(addParam);
                    if (p && isProductVisible(p)) { added = addToCart(p.id, 1); if (added) SELECTED_PRODUCT_ID = p.id; }
                } catch (e) { }
            } else SELECTED_PRODUCT_ID = addParam;
        }
        if (!added) showToast('No se pudo agregar el producto desde el enlace.');
    }

    const gridEl = await waitFor('#productsGrid', 2000);
    const carouselEl = document.getElementById('carousel');
    if (hideProducts) {
        document.documentElement.classList.add('hide-products-mode');
        const pg = document.getElementById('productsGrid'); if (pg) pg.style.display = 'none';
        if (carouselEl) { const carSection = carouselEl.closest('.carousel') || carouselEl.parentElement; if (carSection) carSection.style.display = ''; }
    } else {
        document.documentElement.classList.remove('hide-products-mode');
        const pg = document.getElementById('productsGrid'); if (pg) pg.style.display = '';
    }

    if (openCart) {
        setTimeout(() => { renderCartPanel(); const cp = document.getElementById('cartPanel'); if (cp) cp.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 160);
    }
}

/* ----------------------
   Prevención de double-submit y confirm duplicados
   ---------------------- */
let IS_SUBMITTING = false;
let ORDER_CONFIRM_SHOWN = false;
function hideAllOrderConfirmations() {
    const inline = document.getElementById('orderConfirmInline');
    if (inline) inline.classList.add('hidden');
    const oldModal = document.getElementById('orderConfirmModal');
    if (oldModal) oldModal.classList.add('hidden');
    document.querySelectorAll('.order-confirm').forEach(n => n.classList.add('hidden'));
    ORDER_CONFIRM_SHOWN = false;
}
function openConfirmInline(msg) {
    hideAllOrderConfirmations();
    const modal = document.getElementById('orderConfirmInline');
    if (!modal) return;
    const txt = document.getElementById('orderConfirmText');
    if (txt) txt.textContent = msg || 'Su pedido será atendido pronto. Gracias por comprar con nosotros.';
    modal.classList.remove('hidden');
    modal.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ORDER_CONFIRM_SHOWN = true;
}
async function submitOrder(customerData) {
    if (!CART.items.length) { showToast('El carrito está vacío'); return; }
    if (IS_SUBMITTING) { console.warn('Intento de envío duplicado bloqueado'); return; }
    IS_SUBMITTING = true;

    const checkoutForm = document.getElementById('checkoutForm');
    const submitBtn = document.getElementById('checkoutSubmitBtn') || (checkoutForm ? checkoutForm.querySelector('button[type="submit"]') : null);
    if (submitBtn) { submitBtn.disabled = true; submitBtn.setAttribute('aria-disabled', 'true'); }

    const msgEl = document.getElementById('checkoutMsg');
    if (msgEl) { msgEl.textContent = 'Enviando pedido…'; msgEl.style.color = '#64748b'; }

    const orderData = {
        cartToken: CART.cartToken,
        customerData: {
            Customname: customerData.name,
            email: customerData.email,
            phone: customerData.phone,
            address: customerData.address
        },
        items: CART.items.map(i => ({ productId: i.productId, name: i.name, price: i.price, quantity: i.quantity, subtotal: i.subtotal })),
        total: CART.total,
        status: "pendiente",
        timestamp: serverTimestamp(),
        orderDate: new Date().toISOString()
    };

    try {
        const ordersCol = collection(db, 'orders');
        const docRef = await addDoc(ordersCol, orderData);

        hideAllOrderConfirmations();
        openConfirmInline('Su pedido será atendido pronto. Número: ' + docRef.id);

        clearCart();
        document.getElementById('checkoutPanel')?.classList.add('hidden');
        document.getElementById('cartPanel')?.classList.remove('minimized');
        renderCartPanel();
    } catch (err) {
        console.error('Error guardando pedido:', err);
        if (msgEl) { msgEl.textContent = 'Error al enviar pedido. Intente nuevamente.'; msgEl.style.color = '#ef4444'; }
        showToast('Error guardando pedido en servidor');
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.removeAttribute('aria-disabled'); }
        IS_SUBMITTING = false;
    }
}

/* ----------------------
   Form validation (tiempo real)
   - Nombre: requerido
   - Email: formato básico
   - Teléfono: solo dígitos, entre 8 y 15 dígitos
   - Dirección: requerido, min 6 chars
   ---------------------- */
function validateName() {
    const el = document.getElementById('cust_name');
    const err = document.getElementById('cust_name_err');
    if (!el) return false;
    const v = el.value.trim();
    if (!v) { if (err) err.textContent = 'El nombre es obligatorio.'; return false; }
    if (v.length < 2) { if (err) err.textContent = 'Nombre demasiado corto.'; return false; }
    if (err) err.textContent = '';
    return true;
}
function validateEmail() {
    const el = document.getElementById('cust_email');
    const err = document.getElementById('cust_email_err');
    if (!el) return false;
    const v = el.value.trim();
    const re = /^\S+@\S+\.\S+$/;
    if (!v) { if (err) err.textContent = 'El correo es obligatorio.'; return false; }
    if (!re.test(v)) { if (err) err.textContent = 'Formato de correo inválido (ejemplo@ejemplo.com).'; return false; }
    if (err) err.textContent = '';
    return true;
}
function validatePhone() {
    const el = document.getElementById('cust_phone');
    const err = document.getElementById('cust_phone_err');
    if (!el) return false;
    const v = el.value.trim();
    if (!v) { if (err) err.textContent = 'El teléfono es obligatorio.'; return false; }
    // permitir solo dígitos (sin letras). Longitud entre 8 y 15 dígitos.
    if (!/^\d{8,15}$/.test(v)) {
        if (err) err.textContent = 'Número inválido. Usa sólo dígitos (8 a 15 números).';
        return false;
    }
    if (err) err.textContent = '';
    return true;
}
function validateAddress() {
    const el = document.getElementById('cust_address');
    const err = document.getElementById('cust_address_err');
    if (!el) return false;
    const v = el.value.trim();
    if (!v) { if (err) err.textContent = 'La dirección es obligatoria.'; return false; }
    if (v.length < 6) { if (err) err.textContent = 'Describe la dirección con más detalle.'; return false; }
    if (err) err.textContent = '';
    return true;
}
function validateFormAll() {
    const ok = validateName() && validateEmail() && validatePhone() && validateAddress();
    const submitBtn = document.getElementById('checkoutSubmitBtn');
    if (submitBtn) submitBtn.disabled = !ok;
    return ok;
}

/* Helper: sanitize phone input to digits only */
function phoneInputHandler(e) {
    const el = e.currentTarget;
    const before = el.value;
    const cleaned = before.replace(/\D/g, '').slice(0, 15);
    if (cleaned !== before) el.value = cleaned;
    validatePhone();
    validateFormAll();
}

/* ----------------------
   Submit handler nombrado
   ---------------------- */
function submitHandler(e) {
    e.preventDefault();
    const name = document.getElementById('cust_name').value.trim();
    const email = document.getElementById('cust_email').value.trim();
    const phone = document.getElementById('cust_phone').value.trim();
    const address = document.getElementById('cust_address').value.trim();
    const msg = document.getElementById('checkoutMsg');

    if (!validateFormAll()) {
        if (msg) { msg.textContent = 'Corrige los campos indicados antes de enviar.'; msg.style.color = '#ef4444'; }
        return;
    }
    submitOrder({ name, email, phone, address });
}

/* ----------------------
   Global events & interactions
   ---------------------- */
function attachGlobalEvents() {
    document.getElementById('openCartBtn')?.addEventListener('click', () => {
        const cp = document.getElementById('cartPanel'); if (cp) cp.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Minimize cart button
    document.getElementById('minimizeCartBtn')?.addEventListener('click', () => {
        const cp = document.getElementById('cartPanel');
        if (!cp) return;
        cp.classList.toggle('minimized');
    });

    document.getElementById('clearCartBtn')?.addEventListener('click', async () => {
        const ok = await showConfirm('Vaciar carrito?');
        if (ok) { clearCart(); renderCartPanel(); }
    });

    document.getElementById('continueWithData')?.addEventListener('click', () => {
        // minimizar carrito visualmente y abrir checkout
        const cp = document.getElementById('cartPanel');
        if (cp) cp.classList.add('minimized');
        const checkout = document.getElementById('checkoutPanel');
        if (checkout) {
            checkout.classList.remove('hidden');
            const totalHeader = document.getElementById('checkoutTotalHeader');
            if (totalHeader) totalHeader.textContent = `Total: ${formatCurrency(CART.total || 0)}`;
            checkout.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });

    document.getElementById('cancelCheckout')?.addEventListener('click', () => {
        document.getElementById('checkoutPanel')?.classList.add('hidden');
        document.getElementById('cartPanel')?.classList.remove('minimized');
    });

    document.getElementById('backToCart')?.addEventListener('click', () => {
        document.getElementById('checkoutPanel')?.classList.add('hidden');
        document.getElementById('cartPanel')?.classList.remove('minimized');
    });

    document.getElementById('closeConfirm')?.addEventListener('click', () => {
        document.getElementById('orderConfirmInline')?.classList.add('hidden');
    });

    // form validation events
    const nameEl = document.getElementById('cust_name');
    const emailEl = document.getElementById('cust_email');
    const phoneEl = document.getElementById('cust_phone');
    const addrEl = document.getElementById('cust_address');

    if (nameEl) { nameEl.addEventListener('input', () => { validateName(); validateFormAll(); }); nameEl.addEventListener('blur', validateName); }
    if (emailEl) { emailEl.addEventListener('input', () => { validateEmail(); validateFormAll(); }); emailEl.addEventListener('blur', validateEmail); }
    if (phoneEl) { phoneEl.addEventListener('input', phoneInputHandler); phoneEl.addEventListener('blur', validatePhone); }
    if (addrEl) { addrEl.addEventListener('input', () => { validateAddress(); validateFormAll(); }); addrEl.addEventListener('blur', validateAddress); }

    // submit: attach named handler (remove old to avoid duplicates)
    const checkoutForm = document.getElementById('checkoutForm');
    if (checkoutForm) {
        try { checkoutForm.removeEventListener('submit', submitHandler); } catch (e) { /* ignore */ }
        checkoutForm.addEventListener('submit', submitHandler);
    }

    document.querySelectorAll('.confirm-modal').forEach(m => {
        m.addEventListener('click', (e) => {
            if (e.target === m) {
                m.classList.add('hidden');
                m.setAttribute('aria-hidden', 'true');
            }
        });
    });

    // ESC to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.confirm-modal, .order-confirm, .modal').forEach(m => { m.classList.add('hidden'); m.setAttribute('aria-hidden', 'true'); });
        }
    });
}

/* ----------------------
   Product page rendering (product.html)
   ---------------------- */
async function renderProductPage() {
    const productArea = document.getElementById('productArea');
    if (!productArea) return;
    const params = new URLSearchParams(window.location.search);
    const productParam = params.get('product');
    if (!productParam) { productArea.innerHTML = `<div style="padding:14px">Parámetro de producto faltante. <a href="index.html">Volver a tienda</a></div>`; return; }
    try {
        let prod = PRODUCTS_BY_ID.get(productParam) || null;
        if (!prod) prod = await fetchProductByIdOrSlug(productParam);
        if (!prod) { productArea.innerHTML = `<div style="padding:14px">Producto no encontrado. <a href="index.html">Volver a tienda</a></div>`; return; }
        productArea.innerHTML = `
      <div class="product-card" style="max-width:900px;margin:0 auto;flex-direction:row;align-items:flex-start;">
        <img src="${escapeHtml(prod.image)}" alt="${escapeHtml(prod.name)}" style="width:300px;height:300px;object-fit:cover;border-radius:8px">
        <div style="flex:1">
          <h2 style="margin-bottom:8px">${escapeHtml(prod.name)}</h2>
          <div style="margin-bottom:12px">${prod.discountPrice ? `<span class="old">${formatCurrency(prod.price)}</span> <strong>${formatCurrency(prod.discountPrice)}</strong>` : `<strong>${formatCurrency(prod.price)}</strong>`}</div>
          <p style="margin-bottom:12px;color:#334155">${escapeHtml(prod.description)}</p>
          <div style="display:flex;gap:8px;align-items:center">
            <label style="display:flex;align-items:center;gap:8px">Cantidad: <input id="productQty" type="number" min="1" max="999" value="1" style="width:80px;padding:6px;border-radius:8px;border:1px solid #e6eef6"></label>
            <button id="addProductBtn" class="btn-primary">Agregar al carrito</button>
            <a class="btn-secondary" href="index.html">Volver</a>
          </div>
        </div>
      </div>
    `;
        document.getElementById('addProductBtn').addEventListener('click', () => {
            const q = parseInt(document.getElementById('productQty').value, 10) || 1;
            addToCart(prod.id, q);
            showToast('Producto agregado');
            renderCartPanel();
        });
    } catch (err) { console.error('Error mostrando producto:', err); productArea.innerHTML = `<div style="padding:14px">Error al cargar producto. Intenta recargar la página.</div>`; }
}

/* ----------------------
   Bootstrapping
   ---------------------- */
async function boot() {
    loadCartFromCookie();
    attachGlobalEvents();
    renderCartCount();
    try {
        await fetchAllProductsFromFirestore();
        if (document.getElementById('productsGrid')) {
            const spinner = document.getElementById('productsSpinner'); spinner?.remove();
            renderProductsGrid();
            setupCarousel();
        }
        if (document.getElementById('productArea')) await renderProductPage();
        await Promise.all(PRODUCTS.map(p => resolveProductImages(p)));
        await handleUrlAddParams();
        renderCartPanel();
        // ensure form validation state evaluated on boot
        validateFormAll();
    } catch (err) {
        const productsGrid = document.getElementById('productsGrid');
        if (productsGrid) { productsGrid.innerHTML = `<div style="padding:16px;color:#ef4444">No se pudieron cargar los productos. Revisa la conexión o la colección "product" en Firestore.</div>`; }
        showToast('Error cargando productos (ver consola).', 4000);
    }
}

window.addEventListener('load', boot);
export { }; // keep module scope