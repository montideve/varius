// assets/js/vendedor-orders.js (FIXED: mejor resolución de imágenes desde Storage + caching + fallback a product doc)
// - Añadí cache para evitar llamadas repetidas a getDownloadURL()
// - Si item.image es:
//    * URL http(s) => se usa tal cual
//    * gs://... => se convierte y se llama a getDownloadURL
//    * path tipo "products/<folder>/file.jpg" => se llama a getDownloadURL
//    * cadena vacía o sólo filename => si existe productId se intenta leer el documento product/<productId> y usar imageUrls o imagePaths desde ahí
// - Si no se puede resolver la imagen se muestra un placeholder (iniciales)
// - showOrderModal espera a resolver imágenes en paralelo antes de renderizar

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    query,
    where,
    orderBy,
    onSnapshot,
    doc,
    getDoc,
    updateDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getStorage,
    ref as storageRef,
    getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const tbody = document.getElementById('ordersTbody');
const applyBtn = document.getElementById('applyFilters');
const resetBtn = document.getElementById('resetFilters');
const searchInput = document.getElementById('q');
const downloadCsvBtn = document.getElementById('downloadCsv');
const toastEl = document.getElementById('toast');
const kpiAssigned = document.getElementById('kpi-assigned');

const viewModal = document.getElementById('viewModal');
const viewModalBody = document.getElementById('viewModalBody');
const viewModalClose = document.getElementById('viewModalClose');
const viewCloseBtn = document.getElementById('viewCloseBtn');

const kpiModal = document.getElementById('kpiModal');
const kpiModalTitle = document.getElementById('kpiModalTitle');
const kpiModalBody = document.getElementById('kpiModalBody');
const kpiModalClose = document.getElementById('kpiModalClose');
const kpiModalCloseBtn = document.getElementById('kpiModalCloseBtn');

let currentUser = null;
let currentUserRole = null;
let unsubscribeOrders = null;
let ordersCache = [];
let activeFilter = {};

// Caches
const urlCache = new Map(); // storagePath or gs:// -> downloadURL
const productImagesCache = new Map(); // productId -> [urls]

function showToast(msg, isError = false, ms = 3500) {
    if (!toastEl) return alert(msg);
    toastEl.textContent = msg;
    toastEl.style.background = isError ? '#b91c1c' : '#111827';
    toastEl.classList.remove('hidden');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function formatDate(ts) {
    if (!ts) return '-';
    if (ts.toDate) ts = ts.toDate();
    const d = new Date(ts);
    return d.toLocaleString();
}

async function ensureRoleIsSeller(user) {
    try {
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        const role = snap.exists() ? (snap.data().role || '') : '';
        currentUserRole = role;
        return role === 'vendedor';
    } catch (err) {
        console.error('Error leyendo rol:', err);
        return false;
    }
}

function hideAdminControls() {
    document.querySelectorAll('.admin-only').forEach(el => el.remove());
}

function listenSellerOrders(uid) {
    if (unsubscribeOrders) {
        unsubscribeOrders();
        unsubscribeOrders = null;
    }
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, where('assignedSeller', '==', uid), orderBy('orderDate', 'desc'));
    unsubscribeOrders = onSnapshot(q, snapshot => {
        const arr = [];
        snapshot.forEach(docSnap => arr.push({ id: docSnap.id, ...docSnap.data() }));
        ordersCache = arr;
        renderOrders();
    }, err => {
        console.error('Orders onSnapshot error:', err);
        showToast('No se pudo conectar a pedidos en tiempo real.', true);
    });
}

function normalizeOrder(raw) {
    const o = { ...raw };
    o.clientName = (raw.customerData && (raw.customerData.Customname || raw.customerData.name || raw.customerData.customName)) || raw.customerName || raw.customer || (raw.customer && raw.customer.name) || '';
    o.productTitle = (Array.isArray(raw.items) && raw.items.length) ? raw.items.map(i => i.name || i.title || '').join(', ') : (raw.productTitle || raw.productName || '');
    o._orderDate = raw.orderDate && raw.orderDate.toDate ? raw.orderDate.toDate() : (raw.orderDate ? new Date(raw.orderDate) : raw.createdAt && raw.createdAt.toDate ? raw.createdAt.toDate() : null);
    o.paymentStatus = (raw.paymentStatus || raw.payment || '').toString().toLowerCase();
    o.shippingStatus = (raw.shippingStatus || raw.status || '').toString().toLowerCase();
    // total normalization
    o.totalNum = typeof raw.total === 'number' ? raw.total : (typeof raw.amount === 'number' ? raw.amount : (raw.total ? Number(raw.total) : 0));
    // items normalized for quantity, images and productId fallback
    o._items = Array.isArray(raw.items) ? raw.items.map(it => ({
        id: it.id || it.productId || it.product_id || '',
        name: it.name || it.title || '',
        qty: Number(it.quantity || it.qty || 1),
        price: Number(it.price || it.unitPrice || 0),
        imageRef: it.image || it.imageUrl || it.thumbnail || it.imagePath || it.storagePath || it.path || '',
        productId: it.productId || it.product_id || it.product || ''
    })) : [];
    o.totalItemsCount = o._items.reduce((s, it) => s + (it.qty || 0), 0);
    o.customerDataNormalized = raw.customerData || raw.customer || {};
    return o;
}

// Fetch product document and resolve its imageUrls or imagePaths (cached)
async function fetchProductImages(productId) {
    if (!productId) return [];
    if (productImagesCache.has(productId)) return productImagesCache.get(productId);
    try {
        const pSnap = await getDoc(doc(db, 'product', productId));
        if (!pSnap.exists()) {
            productImagesCache.set(productId, []);
            return [];
        }
        const pdata = pSnap.data();
        // Prefer imageUrls (already downloadable URLs)
        if (Array.isArray(pdata.imageUrls) && pdata.imageUrls.length) {
            productImagesCache.set(productId, pdata.imageUrls.slice());
            return pdata.imageUrls.slice();
        }
        // If imagePaths array present -> resolve each with getDownloadURL
        const pathCandidates = Array.isArray(pdata.imagePaths) && pdata.imagePaths.length ? pdata.imagePaths.slice() : (pdata.imagePath ? [pdata.imagePath] : []);
        if (pathCandidates.length) {
            const resolved = await Promise.all(pathCandidates.map(async p => {
                try {
                    if (!p) return '';
                    if (urlCache.has(p)) return urlCache.get(p);
                    const ref = storageRef(storage, p.startsWith('/') ? p.slice(1) : p);
                    const durl = await getDownloadURL(ref);
                    urlCache.set(p, durl);
                    return durl;
                } catch (e) {
                    console.warn('fetchProductImages: no se pudo resolver path', p, e);
                    return '';
                }
            }));
            const filtered = resolved.filter(Boolean);
            productImagesCache.set(productId, filtered);
            return filtered;
        }
        // If single imageUrl field exists
        if (pdata.imageUrl) {
            productImagesCache.set(productId, [pdata.imageUrl]);
            return [pdata.imageUrl];
        }
        productImagesCache.set(productId, []);
        return [];
    } catch (err) {
        console.error('fetchProductImages error', err);
        productImagesCache.set(productId, []);
        return [];
    }
}

// Resolve an image reference into a usable HTTP URL with caching and fallbacks.
// imgRefOrUrl: can be http(s) URL, gs://..., storage path, or filename.
// productId: optional fallback to read product doc images
async function resolveImageUrl(imgRefOrUrl, productId) {
    try {
        if (imgRefOrUrl && /^https?:\/\//i.test(imgRefOrUrl)) return imgRefOrUrl;
        const v = (imgRefOrUrl || '').toString().trim();
        if (!v && productId) {
            // fallback: use product main image
            const pimgs = await fetchProductImages(productId);
            return pimgs[0] || '';
        }
        if (!v) return '';

        // gs://bucket/path -> remove prefix and use path
        if (/^gs:\/\//i.test(v)) {
            const path = v.replace(/^gs:\/\/[^\/]+\//i, '');
            if (!path) return '';
            if (urlCache.has(v)) return urlCache.get(v);
            try {
                const ref = storageRef(storage, path);
                const durl = await getDownloadURL(ref);
                urlCache.set(v, durl);
                return durl;
            } catch (e) {
                console.warn('resolveImageUrl gs:// failed', v, e);
                // try fallback to product
                if (productId) {
                    const pimgs = await fetchProductImages(productId);
                    return pimgs[0] || '';
                }
                return '';
            }
        }

        // If looks like a storage path (contains products/ or has an extension)
        let pathCandidate = v;
        if (pathCandidate.startsWith('/')) pathCandidate = pathCandidate.slice(1);

        const looksLikePath = /products\//i.test(pathCandidate) || /\.[a-zA-Z0-9]{2,5}$/.test(pathCandidate);
        if (looksLikePath) {
            if (urlCache.has(pathCandidate)) return urlCache.get(pathCandidate);
            try {
                const ref = storageRef(storage, pathCandidate);
                const durl = await getDownloadURL(ref);
                urlCache.set(pathCandidate, durl);
                return durl;
            } catch (e) {
                console.warn('resolveImageUrl path failed', pathCandidate, e);
                // fallback: if productId available, try product doc images
                if (productId) {
                    const pimgs = await fetchProductImages(productId);
                    return pimgs[0] || '';
                }
                return '';
            }
        }

        // If it's likely a bare filename (e.g. "imagen_1.jpg") try product doc if productId provided
        if (productId) {
            const pimgs = await fetchProductImages(productId);
            // try to find a product image that endsWith the filename
            const match = pimgs.find(u => u.endsWith(pathCandidate) || u.includes(pathCandidate));
            if (match) return match;
            return pimgs[0] || '';
        }

        // Otherwise cannot resolve
        return '';
    } catch (err) {
        console.error('resolveImageUrl unexpected error', err);
        return '';
    }
}

function matchesFilters(o, filters) {
    if (filters.fechaInicio) {
        const start = new Date(filters.fechaInicio); start.setHours(0, 0, 0, 0);
        if (!o._orderDate || o._orderDate < start) return false;
    }
    if (filters.fechaFin) {
        const end = new Date(filters.fechaFin); end.setHours(23, 59, 59, 999);
        if (!o._orderDate || o._orderDate > end) return false;
    }
    if (filters.productoFiltro) {
        if (!o.productTitle || !o.productTitle.toLowerCase().includes(filters.productoFiltro.toLowerCase())) return false;
    }
    if (filters.estadoPago) {
        if ((o.paymentStatus || '') !== filters.estadoPago) return false;
    }
    if (filters.estadoEnvio) {
        if ((o.shippingStatus || '') !== filters.estadoEnvio) return false;
    }
    if (filters.search) {
        const s = filters.search.toLowerCase();
        const possible = [
            (o.clientName || '').toLowerCase(),
            (o.productTitle || '').toLowerCase(),
            (o.id || '').toLowerCase()
        ];
        if (!possible.some(p => p.includes(s))) return false;
    }
    return true;
}

function renderOrders() {
    if (!tbody) return;
    tbody.innerHTML = '';
    const visible = ordersCache.map(normalizeOrder).filter(o => matchesFilters(o, activeFilter));
    if (visible.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="10" style="text-align:center;padding:18px;">No hay pedidos para mostrar</td>`;
        tbody.appendChild(tr);
        if (kpiAssigned) kpiAssigned.textContent = '0';
        return;
    }

    visible.forEach(o => {
        const tr = document.createElement('tr');

        const idTd = `<td>${escapeHtml(o.id)}</td>`;
        const clientTd = `<td>${escapeHtml(o.clientName || '')}</td>`;
        const productTd = `<td>${escapeHtml(o.productTitle || '')}</td>`;
        const qtyTd = `<td>${escapeHtml(o.totalItemsCount || 0)}</td>`;
        const dateTd = `<td>${formatDate(o._orderDate)}</td>`;
        const totalTd = `<td>${escapeHtml(o.totalNum || 0)}</td>`;
        const paymentBadge = `<td><span class="badge ${o.paymentStatus === 'pagado' || o.paymentStatus === 'paid' ? 'paid' : 'pending'}">${escapeHtml(o.paymentStatus || 'pendiente')}</span></td>`;
        const shippingBadge = `<td><span class="badge ${o.shippingStatus === 'entregado' ? 'delivered' : (o.shippingStatus === 'enviado' ? 'shipped' : 'pending')}">${escapeHtml(o.shippingStatus || 'pendiente')}</span></td>`;
        const motorTd = `<td>${escapeHtml(o.assignedMotorName || o.assignedMotor || '—')}</td>`;

        const btnView = `<button class="icon-btn btn-link" data-order="${o.id}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16">
            <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/>
            <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/>
        </svg>
        </button>`;
        const canMarkSent = true;
        const btnMarkSent = `<button class="icon-btn mark-sent" data-order="${o.id}" ${canMarkSent ? '' : 'disabled'} title="${canMarkSent ? '' : 'Requiere asignaciones'}">Marcar enviado</button>`;

        const phone = (o.customerDataNormalized && (o.customerDataNormalized.phone || o.customerDataNormalized.telefono || o.customerDataNormalized.mobile)) || '';
        const whatsappBtn = `<button class="icon-btn btn-edit" data-order="${o.id}" ${phone ? '' : 'disabled'} title="${phone ? 'Abrir WhatsApp' : 'No hay teléfono disponible'}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-whatsapp" viewBox="0 0 16 16">
            <path d="M13.601 2.326A7.85 7.85 0 0 0 7.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.9 7.9 0 0 0 3.79.965h.004c4.368 0 7.926-3.558 7.93-7.93A7.9 7.9 0 0 0 13.6 2.326zM7.994 14.521a6.6 6.6 0 0 1-3.356-.92l-.24-.144-2.494.654.666-2.433-.156-.251a6.56 6.56 0 0 1-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 0 1 4.66 1.931 6.56 6.56 0 0 1 1.928 4.66c-.004 3.639-2.961 6.592-6.592 6.592m3.615-4.934c-.197-.099-1.17-.578-1.353-.646-.182-.065-.315-.099-.445.099-.133.197-.513.646-.627.775-.114.133-.232.148-.43.05-.197-.1-.836-.308-1.592-.985-.59-.525-.985-1.175-1.103-1.372-.114-.198-.011-.304.088-.403.087-.088.197-.232.296-.346.1-.114.133-.198.198-.33.065-.134.034-.248-.015-.347-.05-.099-.445-1.076-.612-1.47-.16-.389-.323-.335-.445-.34-.114-.007-.247-.007-.38-.007a.73.73 0 0 0-.529.247c-.182.198-.691.677-.691 1.654s.71 1.916.81 2.049c.098.133 1.394 2.132 3.383 2.992.47.205.84.326 1.129.418.475.152.904.129 1.246.08.38-.058 1.171-.48 1.338-.943.164-.464.164-.86.114-.943-.049-.084-.182-.133-.38-.232"/>
        </svg>
        </button>`;

        const actionsTd = `<td class="actions">${btnView} ${btnMarkSent} ${whatsappBtn}</td>`;

        tr.innerHTML = `${idTd}${clientTd}${productTd}${qtyTd}${dateTd}${totalTd}${paymentBadge}${shippingBadge}${motorTd}${actionsTd}`;
        tbody.appendChild(tr);
    });

    if (kpiAssigned) kpiAssigned.textContent = String(visible.length);

    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.onclick = () => showOrderModal(btn.dataset.order);
    });
    document.querySelectorAll('.mark-sent').forEach(btn => {
        btn.onclick = async () => {
            const orderId = btn.dataset.order;
            try {
                const orderRef = doc(db, 'orders', orderId);
                await updateDoc(orderRef, { shippingStatus: 'enviado', shippingUpdatedAt: serverTimestamp() });
                showToast('Pedido marcado como enviado.');
            } catch (err) {
                console.error('Error marcando enviado:', err);
                showToast('Error marcando enviado.', true);
            }
        };
    });

    // WhatsApp handler
    document.querySelectorAll('.whatsapp-btn').forEach(btn => {
        btn.onclick = async () => {
            const orderId = btn.dataset.order;
            try {
                if (!currentUser) { showToast('Usuario no autenticado', true); return; }
                const orderRef = doc(db, 'orders', orderId);
                const snap = await getDoc(orderRef);
                if (!snap.exists()) { showToast('Pedido no encontrado', true); return; }
                const data = snap.data();
                const phoneRaw = (data.customerData && (data.customerData.phone || data.customerData.telefono || data.customerData.mobile)) || '';
                if (!phoneRaw) { showToast('No hay teléfono del cliente', true); return; }
                const digits = phoneRaw.replace(/[^\d+]/g, '');
                const waNumber = digits.replace(/\D/g, '');
                if (!waNumber) { showToast('Número inválido', true); return; }

                // Update Firestore: communication status
                await updateDoc(orderRef, {
                    communicationStatus: 'contacting',
                    communicationBy: currentUser.uid,
                    communicationUpdatedAt: serverTimestamp()
                });

                const defaultText = `Hola, soy ${currentUser.email || 'el repartidor'}. Estoy contactando sobre tu pedido ${orderId}.`;
                const text = encodeURIComponent(defaultText);
                const waUrl = `https://wa.me/${waNumber}?text=${text}`;

                window.open(waUrl, '_blank');
                showToast('Abriendo WhatsApp...');
            } catch (err) {
                console.error('WhatsApp action error:', err);
                showToast('No se pudo abrir WhatsApp', true);
            }
        };
    });
}

// showOrderModal: carga orden y resuelve imágenes desde storage si es necesario
async function showOrderModal(orderId) {
    if (!orderId) return;
    try {
        const orderRef = doc(db, 'orders', orderId);
        const snap = await getDoc(orderRef);
        if (!snap.exists()) { showToast('Pedido no encontrado', true); return; }
        const data = { id: snap.id, ...snap.data() };

        // customer card
        const cust = data.customerData || data.customer || {};
        const custName = cust.Customname || cust.name || cust.customName || data.customerName || '';
        const custPhone = cust.phone || cust.telefono || cust.mobile || '';
        const custEmail = cust.email || '';
        const custAddress = (cust.address && (cust.address.line1 || cust.address)) || (data.address || '');

        // items list (normalized)
        const rawItems = Array.isArray(data.items) ? data.items.map(it => ({
            id: it.id || it.productId || it.product_id || '',
            name: it.name || it.title || '',
            qty: Number(it.quantity || it.qty || 1),
            price: Number(it.price || it.unitPrice || 0),
            imageRef: it.image || it.imageUrl || it.thumbnail || it.imagePath || it.storagePath || it.path || '',
            productId: it.productId || it.product_id || it.product || ''
        })) : [];

        // Resolve all image references to HTTP URLs in parallel, using productId fallback when needed
        const resolvedUrls = await Promise.all(rawItems.map(it => resolveImageUrl(it.imageRef, it.productId)));
        // Map resolved URL back to items
        const items = rawItems.map((it, idx) => ({ ...it, imageUrl: resolvedUrls[idx] || '' }));

        // build HTML
        const wrap = document.createElement('div');
        wrap.style.display = 'grid';
        wrap.style.gridTemplateColumns = '1fr';
        wrap.style.gap = '12px';

        // customer card
        const cCard = document.createElement('div');
        cCard.className = 'customer-card card';
        cCard.style.display = 'flex';
        cCard.style.gap = '12px';
        cCard.style.alignItems = 'center';
        cCard.style.padding = '12px';

        const avatar = document.createElement('div');
        avatar.className = 'thumb';
        avatar.style.width = '64px';
        avatar.style.height = '64px';
        avatar.style.borderRadius = '8px';
        avatar.style.flex = '0 0 64px';
        avatar.textContent = (custName ? custName.slice(0,2).toUpperCase() : 'CL');

        const meta = document.createElement('div');
        meta.style.flex = '1';
        meta.innerHTML = `<div style="font-weight:700;font-size:15px;">${escapeHtml(custName || '—')}</div>
                          <div style="font-size:13px;color:#6b7280;margin-top:6px;">${escapeHtml(custAddress || '')}</div>
                          <div style="margin-top:8px;font-size:13px;"><strong>Tel:</strong> ${escapeHtml(custPhone || '—')} &nbsp; <strong>Email:</strong> ${escapeHtml(custEmail || '—')}</div>`;

        cCard.appendChild(avatar);
        cCard.appendChild(meta);
        wrap.appendChild(cCard);

        // products list
        const productsWrap = document.createElement('div');
        productsWrap.style.display = 'grid';
        productsWrap.style.gridTemplateColumns = '1fr';
        productsWrap.style.gap = '8px';

        const productsTitle = document.createElement('h3');
        productsTitle.textContent = `Productos (${items.reduce((s, it) => s + (it.qty || 0), 0)})`;
        productsTitle.style.margin = '0 0 6px 0';
        productsWrap.appendChild(productsTitle);

        const list = document.createElement('div');
        list.className = 'order-products-list';
        // responsive grid: will adapt via CSS, but default 2 columns here
        list.style.display = 'grid';
        list.style.gridTemplateColumns = 'repeat(2, 1fr)';
        list.style.gap = '8px';

        items.forEach(it => {
            const card = document.createElement('div');
            card.className = 'product-mini card';
            card.style.display = 'flex';
            card.style.gap = '8px';
            card.style.alignItems = 'center';
            card.style.padding = '8px';

            const imgWrap = document.createElement('div');
            imgWrap.style.width = '58px';
            imgWrap.style.height = '58px';
            imgWrap.style.flex = '0 0 58px';
            imgWrap.style.borderRadius = '6px';
            imgWrap.style.overflow = 'hidden';
            imgWrap.style.background = '#f3f4f6';
            // If imageUrl resolved, show <img>, otherwise show a placeholder div
            if (it.imageUrl) {
                const img = document.createElement('img');
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'cover';
                img.alt = it.name;
                img.loading = 'lazy';
                img.src = it.imageUrl;
                imgWrap.appendChild(img);
            } else {
                // graceful placeholder (initials or icon)
                const ph = document.createElement('div');
                ph.style.width = '100%';
                ph.style.height = '100%';
                ph.style.display = 'flex';
                ph.style.alignItems = 'center';
                ph.style.justifyContent = 'center';
                ph.style.color = '#9aa0a6';
                ph.style.fontWeight = '700';
                ph.textContent = it.name ? it.name.slice(0,2).toUpperCase() : 'IMG';
                imgWrap.appendChild(ph);
            }

            const pdMeta = document.createElement('div');
            pdMeta.style.flex = '1';
            pdMeta.innerHTML = `<div style="font-weight:700">${escapeHtml(it.name)}</div>
                                <div style="font-size:13px;color:#6b7280;margin-top:4px;">Cantidad: ${escapeHtml(it.qty || 0)} • Precio: ${escapeHtml(it.price || 0)}</div>`;

            card.appendChild(imgWrap);
            card.appendChild(pdMeta);
            list.appendChild(card);
        });

        if (!items.length) {
            const empty = document.createElement('div');
            empty.style.padding = '12px';
            empty.textContent = 'No hay productos listados en esta orden';
            list.appendChild(empty);
        }

        productsWrap.appendChild(list);
        wrap.appendChild(productsWrap);

        // additional order meta
        const metaWrap = document.createElement('div');
        metaWrap.style.display = 'flex';
        metaWrap.style.gap = '12px';
        metaWrap.style.flexWrap = 'wrap';

        const infoCols = document.createElement('div');
        infoCols.style.display = 'grid';
        infoCols.style.gridTemplateColumns = 'repeat(2,1fr)';
        infoCols.style.gap = '8px';

        const createdAt = document.createElement('div');
        createdAt.innerHTML = `<div style="font-size:13px;color:#6b7280">Fecha</div><div style="font-weight:700">${formatDate(data.orderDate || data.createdAt)}</div>`;
        const total = document.createElement('div');
        total.innerHTML = `<div style="font-size:13px;color:#6b7280">Total</div><div style="font-weight:700">${escapeHtml(data.total || data.amount || 0)}</div>`;

        infoCols.appendChild(createdAt);
        infoCols.appendChild(total);
        metaWrap.appendChild(infoCols);
        wrap.appendChild(metaWrap);

        // inject into modal body
        viewModalBody.innerHTML = '';
        viewModalBody.appendChild(wrap);

        // show modal
        viewModal.classList.remove('hidden');
        viewModal.setAttribute('aria-hidden', 'false');
    } catch (err) {
        console.error('showOrderModal error', err);
        showToast('No se pudo cargar la orden', true);
    }
}

function closeViewModal() {
    if (!viewModal) return;
    viewModal.classList.add('hidden');
    viewModal.setAttribute('aria-hidden', 'true');
    viewModalBody.innerHTML = '';
}

// KPI modal helpers (unchanged)
function openKpiModal(key) {
    let title = '';
    let body = '';
    if (key === 'orders-today') {
        title = 'Pedidos hoy (tuyos)';
        body = `<p>Muestra la cantidad de pedidos creados hoy asignados a ti. Usa los filtros para acotar por fecha o producto.</p>`;
    } else if (key === 'sales-today') {
        title = 'Ventas hoy (tuyas)';
        body = `<p>Indica la suma de totales de pedidos creados hoy asignados a ti. Si ves valores inesperados revisa que cada pedido tenga total o items con precio.</p>`;
    } else if (key === 'assigned') {
        title = 'Pedidos asignados';
        body = `<p>Pedidos actualmente asignados a ti. Puedes abrir cada pedido para ver la cartilla del cliente y los productos.</p>`;
    } else {
        title = 'Información';
        body = `<p>Información no disponible.</p>`;
    }
    kpiModalTitle.textContent = title;
    kpiModalBody.innerHTML = `<div style="padding:6px 0;color:#374151">${body}</div>`;
    kpiModal.classList.remove('hidden');
    kpiModal.setAttribute('aria-hidden', 'false');
}

function closeKpiModal() {
    if (!kpiModal) return;
    kpiModal.classList.add('hidden');
    kpiModal.setAttribute('aria-hidden', 'true');
    kpiModalBody.innerHTML = '';
}

viewModalClose?.addEventListener('click', closeViewModal);
viewCloseBtn?.addEventListener('click', closeViewModal);

kpiModalClose?.addEventListener('click', closeKpiModal);
kpiModalCloseBtn?.addEventListener('click', closeKpiModal);

// Attach click handlers to KPI cards (delegation)
document.addEventListener('click', (e) => {
    const el = e.target;
    const kpiCard = el.closest('.kpi-card');
    if (kpiCard && kpiCard.dataset && kpiCard.dataset.kpi) {
        openKpiModal(kpiCard.dataset.kpi);
    }
});

// filters
function readFilters() {
    return {
        fechaInicio: document.getElementById('fechaInicio')?.value || '',
        fechaFin: document.getElementById('fechaFin')?.value || '',
        productoFiltro: document.getElementById('productoFiltro')?.value || '',
        estadoPago: document.getElementById('estadoPago')?.value || '',
        estadoEnvio: document.getElementById('estadoEnvio')?.value || '',
        motorizadoFiltro: document.getElementById('motorizadoFiltro')?.value || '',
        search: (searchInput?.value || '').trim()
    };
}
applyBtn?.addEventListener('click', () => { activeFilter = readFilters(); renderOrders(); });
resetBtn?.addEventListener('click', () => { document.getElementById('ordersFilters')?.reset(); searchInput.value = ''; activeFilter = {}; renderOrders(); });
searchInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') { activeFilter = readFilters(); renderOrders(); } });

if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const visible = ordersCache.map(normalizeOrder).filter(o => matchesFilters(o, activeFilter));
        if (!visible.length) { showToast('No hay datos para exportar.'); return; }
        const headers = ['id', 'clientName', 'productTitle', 'createdAt', 'total', 'paymentStatus', 'shippingStatus'];
        const rows = visible.map(o => headers.map(h => {
            if (h === 'createdAt') return formatDate(o._orderDate);
            return `"${String(o[h] || '').replace(/"/g, '""')}"`;
        }).join(','));
        const csv = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `orders_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
    });
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = '/index.html';
        return;
    }
    currentUser = user;
    const isSeller = await ensureRoleIsSeller(user);
    if (!isSeller) {
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        const role = snap.exists() ? (snap.data().role || '') : '';
        if (role === 'administrador') window.location.href = '/admin/administrador.html';
        else if (role === 'motorizado') window.location.href = '/admin/motorizado.html';
        else window.location.href = '/index.html';
        return;
    }

    hideAdminControls();
    listenSellerOrders(user.uid);

    showToast('Conectado como vendedor — mostrando solo tus pedidos');
});