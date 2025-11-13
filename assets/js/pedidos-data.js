// script.js (módulo central actualizado)
// Cambios principales:
// - Soporte para enlaces tipo index.html?add=PRODUCT_ID&openCart=1&hideProducts=1
//   que añaden el producto al carrito y abren la vista del carrito (manteniendo el carrusel).
// - Botones "Copiar enlace" en grid y carousel/product page para generar esos enlaces y copiarlos.
// - No se genera ninguna orden hasta que el usuario complete y envíe el formulario de checkout.
// Nota: este archivo es la versión completa y actualizada (incluye las funciones de Firestore y carrito).

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore, collection, getDocs, getDoc, doc, addDoc, serverTimestamp, query, orderBy, where, limit
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

/* ----------------------
   Inicializa Firebase
   ---------------------- */
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ----------------------
   Helpers: Cookies y Token
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
   Carrito: estructura y operaciones
   ---------------------- */
const CART_COOKIE = 'mi_tienda_cart_v1';
let CART = null;

function createEmptyCart() {
    const token = generateCartToken();
    return {
        cartToken: token,
        items: [],
        total: 0,
        timestamp: new Date().toISOString()
    };
}

function loadCartFromCookie() {
    const c = getCookieJSON(CART_COOKIE);
    if (!c) {
        CART = createEmptyCart();
        persistCart();
        return;
    }
    if (!c.cartToken || !Array.isArray(c.items)) {
        CART = createEmptyCart();
        persistCart();
        return;
    }
    CART = c;
    recalcCart();
}

function persistCart() {
    setCookieJSON(CART_COOKIE, CART, 14);
    renderCartCount();
}

function recalcCart() {
    let total = 0;
    CART.items.forEach(it => {
        it.subtotal = it.quantity * it.price;
        total += it.subtotal;
    });
    CART.total = total;
    CART.timestamp = new Date().toISOString();
}

/* ----------------------
   Productos: obtener desde Firestore
   ---------------------- */
let PRODUCTS = []; // cache local
let PRODUCTS_BY_ID = new Map();

function normalizeProduct(doc) {
    const data = doc.data();
    const price = Number(data.price) || 0;
    const discountPrice = (data.discountPrice !== undefined && data.discountPrice !== null)
        ? Number(data.discountPrice)
        : (data.discount ? Math.max(0, price - Number(data.discount)) : null);
    const isOnSale = !!(data.onOffer || data.isOnSale || data.onoffer || (discountPrice && discountPrice < price));
    const image = data.imageUrl || data.image || data.imageUrl1 || '';
    return {
        id: doc.id,
        name: data.name || data.title || '',
        price,
        discountPrice: (discountPrice && discountPrice > 0) ? discountPrice : null,
        isOnSale,
        image,
        description: data.description || '',
        category: data.category || '',
        slug: data.slug || '',
        status: data.status || 'Activo',
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
    } catch (err) {
        console.error('Error buscando product por id:', err);
    }
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
    } catch (err) {
        console.error('Error buscando product por slug:', err);
    }
    return null;
}

/* ----------------------
   Carrito operations using Firestore products
   ---------------------- */
function formatCurrency(n) {
    try {
        return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n);
    } catch (err) {
        return `$${n}`;
    }
}

function addToCart(productIdOrSlug, qty = 1) {
    const p = PRODUCTS_BY_ID.get(productIdOrSlug);
    if (!p) {
        showToast('Producto no encontrado. Recarga la página.');
        return false;
    }
    const price = (p.discountPrice && Number(p.discountPrice) > 0) ? Number(p.discountPrice) : Number(p.price);
    const existing = CART.items.find(i => i.productId === p.id);
    if (existing) {
        existing.quantity = Math.min(999, existing.quantity + qty);
    } else {
        CART.items.push({
            productId: p.id,
            name: p.name,
            price,
            quantity: Math.max(1, Math.min(999, qty)),
            subtotal: price * qty,
            image: p.image
        });
    }
    recalcCart();
    persistCart();
    showToast('Producto agregado al carrito');
    return true;
}

function updateQuantity(productId, qty) {
    const item = CART.items.find(i => i.productId === productId);
    if (!item) return;
    const q = Math.max(1, Math.min(999, Math.floor(qty)));
    item.quantity = q;
    recalcCart();
    persistCart();
}

function removeItem(productId) {
    CART.items = CART.items.filter(i => i.productId !== productId);
    recalcCart();
    persistCart();
}

function clearCart() {
    CART = createEmptyCart();
    persistCart();
    showToast('Carrito vaciado');
}

/* ----------------------
   UI: Toast, escape & helpers
   ---------------------- */
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
   Build special add-link URL & copy to clipboard
   ---------------------- */
function buildAddLink(productId) {
    // Link to index.html that, when opened, will add product and open cart.
    // include hideProducts to show only carousel + cart modal if desired.
    const origin = window.location.origin;
    // Use absolute index.html (works for most hosting setups)
    const url = `${origin}/tiendita.com/carrito.html?add=${encodeURIComponent(productId)}&openCart=1&hideProducts=1`;
    return url;
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            // fallback
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showToast('Enlace copiado al portapapeles');
        return true;
    } catch (err) {
        console.error('Error al copiar:', err);
        showToast('No se pudo copiar el enlace');
        return false;
    }
}

/* ----------------------
   Render: productos y carrusel (con botón de copiar enlace)
   ---------------------- */
function renderProductsGrid() {
    const el = document.getElementById('productsGrid');
    if (!el) return;
    el.innerHTML = '';
    if (!PRODUCTS.length) {
        el.innerHTML = '<div class="spinner">No hay productos para mostrar.</div>';
        return;
    }
    for (const p of PRODUCTS) {
        const card = document.createElement('article');
        card.className = 'product-card';
        card.innerHTML = `
      <img loading="lazy" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}">
      <div class="product-info">
        <div class="product-title">${escapeHtml(p.name)}</div>
        <div class="product-price">
          ${p.discountPrice ? `<span class="old">${formatCurrency(p.price)}</span><span>${formatCurrency(p.discountPrice)}</span>` : `<span>${formatCurrency(p.price)}</span>`}
        </div>
        <div style="margin-top:8px">
          <a href="product.html?product=${encodeURIComponent(p.id)}" class="btn-secondary" style="margin-right:8px">Ver producto</a>
          <button class="btn-primary add-btn" data-id="${escapeHtml(p.id)}">Agregar</button>
          <button class="btn-secondary copy-link" data-id="${escapeHtml(p.id)}" title="Copiar enlace para añadir al carrito">Copiar enlace</button>
        </div>
      </div>
    `;
        el.appendChild(card);
    }
    // attach listeners
    el.querySelectorAll('.add-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            addToCart(e.currentTarget.dataset.id, 1);
            renderCartModal();
        });
    });
    el.querySelectorAll('.copy-link').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const link = buildAddLink(id);
            await copyToClipboard(link);
            // Optionally select the UI etc.
        });
    });
}

/* Carousel: con botón de copiar enlace en cada slide */
let carouselIndex = 0;
let carouselTimer = null;
function setupCarousel() {
    const track = document.getElementById('carouselTrack');
    const indicators = document.getElementById('carouselIndicators');
    const prev = document.getElementById('carouselPrev');
    const next = document.getElementById('carouselNext');
    if (!track) return;

    const slides = PRODUCTS.filter(p => p.isOnSale || (p.discountPrice && Number(p.discountPrice) < Number(p.price)));
    if (!slides.length) {
        track.innerHTML = '<div style="padding:12px">No hay ofertas disponibles.</div>';
        return;
    }
    track.innerHTML = '';
    indicators.innerHTML = '';
    slides.forEach((s, idx) => {
        const slide = document.createElement('div');
        slide.className = 'carousel-slide';
        slide.innerHTML = `
      <img src="${escapeHtml(s.image)}" alt="${escapeHtml(s.name)}">
      <div>
        <div style="font-weight:700">${escapeHtml(s.name)}</div>
        <div style="margin-top:6px">${s.discountPrice ? `<span class="old">${formatCurrency(s.price)}</span> <strong>${formatCurrency(s.discountPrice)}</strong>` : `<strong>${formatCurrency(s.price)}</strong>`}</div>
        <div style="margin-top:10px">
          <button class="btn-primary add-btn small" data-id="${escapeHtml(s.id)}">Agregar</button>
          <button class="btn-secondary copy-link small" data-id="${escapeHtml(s.id)}">Copiar enlace</button>
          <a class="btn-secondary small" href="product.html?product=${encodeURIComponent(s.id)}">Ver</a>
        </div>
      </div>
    `;
        track.appendChild(slide);

        const ind = document.createElement('button');
        ind.className = 'indicator';
        ind.dataset.index = idx;
        ind.addEventListener('click', () => { goToSlide(idx); });
        indicators.appendChild(ind);
    });

    track.querySelectorAll('.add-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            addToCart(e.currentTarget.dataset.id, 1);
            renderCartModal();
        });
    });

    track.querySelectorAll('.copy-link').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const link = buildAddLink(id);
            await copyToClipboard(link);
        });
    });

    function update() {
        const slideEl = track.querySelector('.carousel-slide');
        if (!slideEl) return;
        const slideWidth = slideEl.clientWidth;
        const offset = -carouselIndex * (slideWidth + 12);
        track.style.transform = `translateX(${offset}px)`;
        indicators.querySelectorAll('.indicator').forEach((el, i) => el.classList.toggle('active', i === carouselIndex));
    }

    function prevSlide() { carouselIndex = Math.max(0, carouselIndex - 1); update(); }
    function nextSlide() { carouselIndex = Math.min(slides.length - 1, carouselIndex + 1); update(); }
    function goToSlide(i) { carouselIndex = Math.max(0, Math.min(slides.length - 1, i)); update(); }

    prev.addEventListener('click', prevSlide);
    next.addEventListener('click', nextSlide);

    const carouselEl = document.getElementById('carousel');
    function startAuto() {
        stopAuto();
        carouselTimer = setInterval(() => {
            carouselIndex = (carouselIndex + 1) % slides.length;
            update();
        }, 3200);
    }
    function stopAuto() { if (carouselTimer) clearInterval(carouselTimer); carouselTimer = null; }
    carouselEl.addEventListener('mouseenter', stopAuto);
    carouselEl.addEventListener('mouseleave', startAuto);

    update();
    startAuto();
}

/* ----------------------
   UI: Carrito modal render
   ---------------------- */
function renderCartCount() {
    const count = CART.items.reduce((s, i) => s + i.quantity, 0);
    const c1 = document.getElementById('cartCount');
    const c2 = document.getElementById('cartCount2');
    if (c1) c1.textContent = count;
    if (c2) c2.textContent = count;
}

function renderCartModal() {
    const itemsEl = document.getElementById('cartItems');
    const subtotalEl = document.getElementById('cartSubtotal');
    const totalEl = document.getElementById('cartTotal');
    if (!itemsEl) return;
    itemsEl.innerHTML = '';
    if (!CART.items.length) {
        itemsEl.innerHTML = '<div style="padding:12px;color:#64748b">Tu carrito está vacío.</div>';
        subtotalEl.textContent = formatCurrency(0);
        totalEl.textContent = formatCurrency(0);
        renderCartCount();
        return;
    }
    for (const it of CART.items) {
        const div = document.createElement('div');
        div.className = 'cart-item';
        div.innerHTML = `
      <img src="${escapeHtml(it.image || '')}" alt="${escapeHtml(it.name)}">
      <div style="flex:1">
        <div style="font-weight:700">${escapeHtml(it.name)}</div>
        <div style="color:#94a3b8">${formatCurrency(it.price)} x ${it.quantity} = <strong>${formatCurrency(it.subtotal)}</strong></div>
        <div style="margin-top:8px" class="qty-controls">
          <button class="qty-decr" data-id="${it.productId}" aria-label="Disminuir">−</button>
          <input class="qty-input" data-id="${it.productId}" type="number" min="1" max="999" value="${it.quantity}" style="width:60px;padding:6px;border-radius:8px;border:1px solid #e6eef6">
          <button class="qty-incr" data-id="${it.productId}" aria-label="Aumentar">+</button>
          <button class="btn-secondary remove-item" data-id="${it.productId}" style="margin-left:8px">Eliminar</button>
        </div>
      </div>
    `;
        itemsEl.appendChild(div);
    }

    itemsEl.querySelectorAll('.qty-incr').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const item = CART.items.find(x => x.productId === id);
            if (!item) return;
            updateQuantity(id, item.quantity + 1);
            renderCartModal();
        });
    });
    itemsEl.querySelectorAll('.qty-decr').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const item = CART.items.find(x => x.productId === id);
            if (!item) return;
            updateQuantity(id, Math.max(1, item.quantity - 1));
            renderCartModal();
        });
    });
    itemsEl.querySelectorAll('.qty-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const id = e.currentTarget.dataset.id;
            let q = parseInt(e.currentTarget.value, 10);
            if (isNaN(q) || q < 1) q = 1;
            updateQuantity(id, q);
            renderCartModal();
        });
    });
    itemsEl.querySelectorAll('.remove-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            if (!confirm('Eliminar artículo del carrito?')) return;
            removeItem(id);
            renderCartModal();
        });
    });

    const subtotal = CART.total;
    subtotalEl.textContent = formatCurrency(subtotal);
    totalEl.textContent = formatCurrency(subtotal);
    renderCartCount();
}

/* ----------------------
   Checkout / Orders (Firestore)
   ---------------------- */
function openCartModal() {
    const modal = document.getElementById('cartModal');
    if (!modal) return;
    renderCartModal();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}
function closeCartModal() {
    const modal = document.getElementById('cartModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

function openCheckoutModal() {
    const modal = document.getElementById('checkoutModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}
function closeCheckoutModal() {
    const modal = document.getElementById('checkoutModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

function openConfirmModal(msg) {
    const modal = document.getElementById('orderConfirmModal');
    if (!modal) return;
    const txt = document.getElementById('orderConfirmText');
    if (txt) txt.textContent = msg || 'Su pedido será atendido pronto. Gracias por comprar con nosotros.';
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}
function closeConfirmModal() {
    const modal = document.getElementById('orderConfirmModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

async function submitOrder(customerData) {
    if (!CART.items.length) {
        showToast('El carrito está vacío');
        return;
    }
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
        items: CART.items.map(i => ({
            productId: i.productId, name: i.name, price: i.price, quantity: i.quantity, subtotal: i.subtotal
        })),
        total: CART.total,
        status: "pendiente",
        timestamp: serverTimestamp(),
        orderDate: new Date().toISOString()
    };

    try {
        const ordersCol = collection(db, 'orders');
        const docRef = await addDoc(ordersCol, orderData);
        if (msgEl) { msgEl.textContent = ''; }
        openConfirmModal('Su pedido será atendido pronto. Número: ' + docRef.id);
        clearCart();
        closeCheckoutModal();
        closeCartModal();
    } catch (err) {
        console.error('Error guardando pedido:', err);
        if (msgEl) {
            msgEl.textContent = 'Error al enviar pedido. Intente nuevamente.';
            msgEl.style.color = '#ef4444';
        }
        showToast('Error guardando pedido en servidor');
    }
}

/* ----------------------
   Product page rendering (product.html)
   ---------------------- */
async function renderProductPage() {
    const productArea = document.getElementById('productArea');
    if (!productArea) return;
    const params = new URLSearchParams(window.location.search);
    const productParam = params.get('product');
    if (!productParam) {
        productArea.innerHTML = `<div style="padding:14px">Parámetro de producto faltante. <a href="index.html">Volver a tienda</a></div>`;
        return;
    }
    try {
        let prod = PRODUCTS_BY_ID.get(productParam) || null;
        if (!prod) prod = await fetchProductByIdOrSlug(productParam);
        if (!prod) {
            productArea.innerHTML = `<div style="padding:14px">Producto no encontrado. <a href="index.html">Volver a tienda</a></div>`;
            return;
        }

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
            <button id="copyLinkBtn" class="btn-secondary">Copiar enlace</button>
            <a class="btn-secondary" href="index.html">Volver</a>
          </div>
        </div>
      </div>
    `;

        document.getElementById('addProductBtn').addEventListener('click', () => {
            const q = parseInt(document.getElementById('productQty').value, 10) || 1;
            addToCart(prod.id, q);
            showToast('Producto agregado');
            renderCartModal();
        });

        document.getElementById('copyLinkBtn').addEventListener('click', async () => {
            const link = buildAddLink(prod.id);
            await copyToClipboard(link);
        });

    } catch (err) {
        console.error('Error mostrando producto:', err);
        productArea.innerHTML = `<div style="padding:14px">Error al cargar producto. Intenta recargar la página.</div>`;
    }
}

/* ----------------------
   URL-handling: manejar ?add=...&openCart=1&hideProducts=1
   ---------------------- */
async function handleUrlAddParams() {
    const params = new URLSearchParams(window.location.search);
    const addParam = params.get('add');
    const openCart = params.get('openCart');
    const hideProducts = params.get('hideProducts');

    if (!addParam) return;

    // asegúrate de que el producto esté cargado en cache
    let success = false;
    if (!PRODUCTS_BY_ID.size) {
        // if not loaded, we try to fetch product by id or slug individually
        const p = await fetchProductByIdOrSlug(addParam);
        if (p) {
            success = addToCart(p.id, 1);
        }
    } else {
        success = addToCart(addParam, 1);
        if (!success) {
            // maybe param is slug or name; try fetching by slug
            const p = await fetchProductByIdOrSlug(addParam);
            if (p) success = addToCart(p.id, 1);
        }
    }

    if (!success) {
        showToast('No se pudo agregar el producto desde el enlace.');
    }

    // Si hideProducts pedimos ocultar el grid de productos pero mantener el carrusel
    if (hideProducts && document.getElementById('productsGrid')) {
        const grid = document.getElementById('productsGrid');
        grid.style.display = 'none';
    }

    // Abrir carrito si se pidió
    if (openCart) {
        // Espera un tick para que renderCartModal tenga DOM listo
        setTimeout(() => {
            openCartModal();
            // scroll to top (UX)
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 120);
    }
}

/* ----------------------
   Init / eventos globales
   ---------------------- */
function attachGlobalEvents() {
    document.querySelectorAll('#openCartBtn, #openCartBtn2').forEach(b => b?.addEventListener('click', openCartModal));
    document.querySelectorAll('#closeCart').forEach(b => b?.addEventListener('click', closeCartModal));
    document.getElementById('clearCartBtn')?.addEventListener('click', () => { if (confirm('Vaciar carrito?')) { clearCart(); renderCartModal(); } });
    document.getElementById('continueWithData')?.addEventListener('click', () => openCheckoutModal());
    document.getElementById('cancelCheckout')?.addEventListener('click', () => closeCheckoutModal());
    document.getElementById('backToCart')?.addEventListener('click', () => closeCheckoutModal());
    document.getElementById('closeConfirm')?.addEventListener('click', () => closeConfirmModal());

    const checkoutForm = document.getElementById('checkoutForm');
    if (checkoutForm) {
        checkoutForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('cust_name').value.trim();
            const email = document.getElementById('cust_email').value.trim();
            const phone = document.getElementById('cust_phone').value.trim();
            const address = document.getElementById('cust_address').value.trim();
            const msg = document.getElementById('checkoutMsg');

            if (!name || !email || !phone || !address) {
                if (msg) { msg.textContent = 'Por favor completa todos los campos obligatorios.'; msg.style.color = '#ef4444'; }
                return;
            }
            if (!/^\S+@\S+\.\S+$/.test(email)) {
                if (msg) { msg.textContent = 'Correo con formato inválido.'; msg.style.color = '#ef4444'; }
                return;
            }
            submitOrder({ name, email, phone, address });
        });
    }

    document.querySelectorAll('.modal').forEach(m => {
        m.addEventListener('click', (e) => {
            if (e.target === m) {
                m.classList.add('hidden');
                m.setAttribute('aria-hidden', 'true');
            }
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal').forEach(m => { m.classList.add('hidden'); m.setAttribute('aria-hidden', 'true'); });
        }
    });
}

/* ----------------------
   Bootstrapping
   ---------------------- */
async function boot() {
    loadCartFromCookie();
    attachGlobalEvents();
    renderCartCount();

    // Load products from Firestore
    try {
        await fetchAllProductsFromFirestore();

        // Page-specific render
        if (document.getElementById('productsGrid')) {
            const spinner = document.getElementById('productsSpinner');
            spinner?.remove();
            renderProductsGrid();
            setupCarousel();
        }
        if (document.getElementById('productArea')) {
            await renderProductPage();
        }

        // Handle URL params AFTER products are loaded and UI ready
        await handleUrlAddParams();

        // Always render cart UI
        renderCartModal();
    } catch (err) {
        const productsGrid = document.getElementById('productsGrid');
        if (productsGrid) {
            productsGrid.innerHTML = `<div style="padding:16px;color:#ef4444">No se pudieron cargar los productos. Revisa la conexión o la colección "product" en Firestore.</div>`;
        }
        showToast('Error cargando productos (ver consola).', 4000);
    }
}

window.addEventListener('load', boot);