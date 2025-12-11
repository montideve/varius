// assets/js/product-admin.js
// Versión completa revisada:
// - Render con badges de estado y oferta (colores).
// - Columna Imagen muestra mini-slider (rotador separado).
// - "Eliminar" marca status = 'suspendido' (soft-delete) y sólo admin ve suspendidos.
// - CRUD y subida de imágenes (usa optimizarImagen, sube a products/{productId}/...).
// - Validaciones de rol (applyUiRestrictions debe ocultar .admin-only).
// - Incluye funciones necesarias: renderProducts, add/update (with image upload), openEdit, soft delete.
// Requiere: image-utils.js, rbac.js y storage.rules apropiadas.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore, collection, query, orderBy, onSnapshot,
    addDoc, doc, updateDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

import { optimizarImagen } from './image-utils.js';
import { applyUiRestrictions } from './rbac.js';

// Init
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// UI elements
const productsBody = document.getElementById('productsBody');
const searchInput = document.getElementById('searchInput');
const stateFilter = document.getElementById('stateFilter');
const offerFilter = document.getElementById('offerFilter');

const productModal = document.getElementById('productModal');
const openAddBtn = document.getElementById('openAddBtn');
const closeModalBtn = document.getElementById('closeModal');
const cancelBtn = document.getElementById('cancelBtn');

const productForm = document.getElementById('productForm');
const modalTitle = document.getElementById('modalTitle');
const toast = document.getElementById('toast');

const productIdField = document.getElementById('productId');
const nameField = document.getElementById('name');
const descriptionField = document.getElementById('description');
const priceField = document.getElementById('price');
const categoryField = document.getElementById('category');
const statusField = document.getElementById('status');
const onOfferField = document.getElementById('onOffer');
const discountField = document.getElementById('discount');
const stockField = document.getElementById('stock');
const imageFileField = document.getElementById('imageFile'); // multiple
const skuField = document.getElementById('sku');

const imageDropZone = document.getElementById('imageDropZone');
const imagePreviewSlider = document.getElementById('imagePreviewSlider');
const slideTrack = document.getElementById('slideTrack');
const prevSlideBtn = document.getElementById('prevSlide');
const nextSlideBtn = document.getElementById('nextSlide');

let productsLocal = [];
let currentUser = null;
let currentUserRole = null;
let isEditing = false;
let editingId = null;
let currentPreviewFiles = [];
let currentPreviewUrls = [];
let currentSavedImageObjs = [];
let pendingDeletePaths = [];

const productsCol = collection(db, 'product');

const CATEGORY_PREFIX = {
    "Ropa": "ROP",
    "Electrónica": "ELE",
    "Hogar": "HOG",
    "Accesorios": "ACC"
};

/* ---------------- Helpers ---------------- */
function showToast(msg, ms = 3000) {
    if (!toast) { console.log('TOAST:', msg); return; }
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
        toast.classList.remove('show');
        toast.classList.add('hidden');
    }, ms);
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;', '=': '&#x3D;', '`': '&#x60;' }[c]));
}

function formatPrice(num) {
    if (num === undefined || num === null || num === '') return '-';
    return Number(num).toLocaleString('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
}
function calculateOfferPrice(price, discount) {
    if (!price || !discount) return null;
    return Math.round(Number(price) * (1 - Number(discount) / 100));
}
function generateSKUForCategory(category) {
    const prefix = CATEGORY_PREFIX[category] || (category ? category.slice(0, 3).toUpperCase() : 'PRD');
    const timePortion = String(Date.now()).slice(-6);
    const rnd = Math.random().toString(36).slice(-4).toUpperCase();
    return `${prefix}-${timePortion}${rnd}`;
}

/* ---------------- Render products ----------------
   uses badges: state-active, state-inactive, state-suspended
   offer badges: offer-yes, offer-no
*/
function renderProducts(list) {
    productsBody.innerHTML = '';
    if (!list.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 9;
        td.style.padding = '28px';
        td.style.textAlign = 'center';
        td.style.color = '#6b7280';
        td.textContent = 'No hay productos';
        tr.appendChild(td);
        productsBody.appendChild(tr);
        document.dispatchEvent(new CustomEvent('products:rendered'));
        return;
    }

    list.forEach(prod => {
        // If suspended and not admin, skip
        if ((prod.status || '').toLowerCase() === 'suspendido' && currentUserRole !== 'administrador') return;

        const tr = document.createElement('tr');

        // Images mini-slider cell
        const tdImg = document.createElement('td');
        tdImg.className = 'mini-slider-cell';
        const sliderWrap = document.createElement('div');
        sliderWrap.className = 'mini-slider';
        const track = document.createElement('div');
        track.className = 'mini-track';

        const images = Array.isArray(prod.imageUrls) && prod.imageUrls.length ? prod.imageUrls : (prod.imageUrl ? [prod.imageUrl] : []);
        if (images.length) {
            images.slice(0, 6).forEach(url => {
                const item = document.createElement('div');
                item.className = 'mini-slide';
                const img = document.createElement('img');
                img.src = url;
                img.alt = prod.name;
                img.loading = 'lazy';
                item.appendChild(img);
                track.appendChild(item);
            });
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'thumb';
            placeholder.textContent = 'IMG';
            sliderWrap.appendChild(placeholder);
        }
        sliderWrap.appendChild(track);
        tdImg.appendChild(sliderWrap);
        tr.appendChild(tdImg);

        // Name & category
        const tdName = document.createElement('td'); tdName.className = 'product-name';
        tdName.innerHTML = `<div>${escapeHtml(prod.name)}</div><div style="font-size:12px;color:#6b7280">${escapeHtml(prod.category || '')}</div>`;
        tr.appendChild(tdName);

        // Price
        const tdPrice = document.createElement('td'); tdPrice.textContent = formatPrice(prod.price); tr.appendChild(tdPrice);

        // Offer badge
        const tdOffer = document.createElement('td');
        const offerBadge = document.createElement('span');
        offerBadge.className = 'badge offer-badge';
        if (prod.onOffer) { offerBadge.classList.add('offer-yes'); offerBadge.textContent = 'En oferta'; }
        else { offerBadge.classList.add('offer-no'); offerBadge.textContent = 'No'; }
        tdOffer.appendChild(offerBadge);
        tr.appendChild(tdOffer);

        // Discount
        const tdDiscount = document.createElement('td');
        tdDiscount.textContent = prod.onOffer ? `-${(prod.discount || 0)}%` : '-';
        tr.appendChild(tdDiscount);

        // Offer price
        const tdOfferPrice = document.createElement('td');
        const op = prod.onOffer ? calculateOfferPrice(prod.price, prod.discount) : null;
        tdOfferPrice.textContent = op ? formatPrice(op) : '-';
        tr.appendChild(tdOfferPrice);

        // Stock
        const tdStock = document.createElement('td'); tdStock.textContent = prod.stock ?? 0; tr.appendChild(tdStock);

        // State badge
        const tdState = document.createElement('td');
        const stateBadge = document.createElement('span');
        stateBadge.className = 'badge-state state-badge';
        const st = (prod.status || 'Activo').toLowerCase();
        if (st === 'activo' || st === 'active') { stateBadge.classList.add('state-active'); stateBadge.textContent = 'Activo'; }
        else if (st === 'inactivo' || st === 'inactive') { stateBadge.classList.add('state-inactive'); stateBadge.textContent = 'Inactivo'; }
        else if (st === 'suspendido' || st === 'suspended') { stateBadge.classList.add('state-suspended'); stateBadge.textContent = 'Suspendido'; }
        else { stateBadge.textContent = prod.status || '—'; }
        tdState.appendChild(stateBadge);
        tr.appendChild(tdState);

        // Actions
        const tdActions = document.createElement('td'); tdActions.className = 'actions';
        const actions = document.createElement('div'); actions.className = 'actions';

        // Copy link - always visible
        const btnCopy = document.createElement('button');
        btnCopy.className = 'icon-btn btn-link';
        btnCopy.title = 'Copiar Enlace';
        btnCopy.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-link-45deg" viewBox="0 0 16 16">
                                <path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1 1 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4 4 0 0 1-.128-1.287z"/>
                                <path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243z"/>
                            </svg>`;
        btnCopy.addEventListener('click', () => copyProductLink(prod.id));
        actions.appendChild(btnCopy);

        // Admin actions: edit and soft-delete
        if (currentUserRole === 'administrador') {
            const btnEdit = document.createElement('button');
            btnEdit.className = 'icon-btn btn-edit';
            btnEdit.title = 'Editar';
            btnEdit.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" fill="currentColor"/><path d="M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/></svg>`;
            btnEdit.addEventListener('click', () => openEditProduct(prod.id));
            actions.appendChild(btnEdit);

            const btnDelete = document.createElement('button');
            btnDelete.className = 'icon-btn btn-suspender';
            btnDelete.title = 'Suspender';
            btnDelete.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
                                        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                                        <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                                    </svg>`;
            btnDelete.addEventListener('click', () => softDeleteProduct(prod.id));
            actions.appendChild(btnDelete);
        }

        tdActions.appendChild(actions);
        tr.appendChild(tdActions);

        productsBody.appendChild(tr);
    });

    // notify for mini-rotator
    document.dispatchEvent(new CustomEvent('products:rendered'));
}

/* ---------------- Copy link ---------------- */
function buildAddLinkForPublic(productId) {
    const origin = window.location.origin;
    const publicPath = '/carrito.html';
    const params = new URLSearchParams({ add: productId, openCart: '1', hideProducts: '1' });
    return `${origin}${publicPath}?${params.toString()}`;
}
async function copyProductLink(id) {
    const link = buildAddLinkForPublic(id);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(link);
        } else {
            const ta = document.createElement('textarea');
            ta.value = link;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showToast('Enlace copiado al portapapeles');
    } catch (err) {
        console.error('copy error', err);
        showToast('No se pudo copiar enlace');
    }
}

/* ---------------- Soft-delete (mark suspendido) ---------------- */
async function softDeleteProduct(id) {
    if (!currentUser) { showToast('No autenticado'); return; }
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }
    const ok = confirm('¿Suspender este producto? (no se eliminará permanentemente)');
    if (!ok) return;
    try {
        const ref = doc(db, 'product', id);
        await updateDoc(ref, { status: 'suspendido', updatedAt: serverTimestamp() });
        showToast('Producto suspendido');
    } catch (err) {
        console.error('softDeleteProduct error', err);
        showToast('Error al suspender producto');
    }
}

/* ---------------- Filters & realtime ---------------- */
function applyFilters() {
    const search = (searchInput.value || '').trim().toLowerCase();
    const stateVal = stateFilter.value;
    const offerVal = offerFilter.value;
    let filtered = productsLocal.slice();
    if (search) filtered = filtered.filter(p => (p.name_lower || '').includes(search));
    if (stateVal) filtered = filtered.filter(p => (p.status || '') === stateVal);
    if (offerVal) {
        if (offerVal === 'en_oferta') filtered = filtered.filter(p => !!p.onOffer);
        if (offerVal === 'no_oferta') filtered = filtered.filter(p => !p.onOffer);
    }
    renderProducts(filtered);
}

function startRealtimeListener() {
    const q = query(productsCol, orderBy('name_lower', 'asc'));
    onSnapshot(q, snapshot => {
        productsLocal = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        applyFilters();
    }, err => {
        console.error('Error listening products', err);
        showToast('Error cargando productos: ' + (err.message || err));
    });
}

/* ---------------- Modal open/edit/submit (simplified) ---------------- */
function clearModalPreviews() {
    currentPreviewFiles = [];
    currentPreviewUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { } });
    currentPreviewUrls = [];
    currentSavedImageObjs = [];
    pendingDeletePaths = [];
    slideTrack.innerHTML = '';
    imagePreviewSlider.classList.add('hidden');
    imagePreviewSlider.setAttribute('aria-hidden', 'true');
}

function openAddModal() {
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }
    isEditing = false;
    editingId = null;
    currentSavedImageObjs = [];
    clearModalPreviews();
    modalTitle.textContent = 'Agregar Producto';
    productForm.reset();
    productIdField.value = '';
    skuField.value = '';
    skuField.placeholder = 'Se generará al seleccionar categoría';
    productModal.classList.remove('hidden');
    productModal.setAttribute('aria-hidden', 'false');
}

async function openEditProduct(id) {
    try {
        const snap = await getDoc(doc(db, 'product', id));
        if (!snap.exists()) { showToast('Producto no encontrado'); return; }
        const prod = { id: snap.id, ...snap.data() };
        if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }
        isEditing = true;
        editingId = id;
        modalTitle.textContent = 'Editar Producto';
        productIdField.value = id;
        nameField.value = prod.name || '';
        descriptionField.value = prod.description || '';
        priceField.value = prod.price || 0;
        categoryField.value = prod.category || '';
        statusField.value = prod.status || 'Activo';
        onOfferField.checked = !!prod.onOffer;
        discountField.value = prod.discount || 0;
        stockField.value = prod.stock || 0;
        skuField.value = prod.sku || '';
        imageFileField.value = '';

        currentSavedImageObjs = [];
        if (Array.isArray(prod.imageUrls) && prod.imageUrls.length) {
            const urls = prod.imageUrls;
            const paths = Array.isArray(prod.imagePaths) ? prod.imagePaths : [];
            for (let i = 0; i < urls.length; i++) currentSavedImageObjs.push({ url: urls[i], path: paths[i] || '' });
        } else if (prod.imageUrl) {
            currentSavedImageObjs.push({ url: prod.imageUrl, path: '' });
        }
        currentPreviewFiles = [];
        currentPreviewUrls = [];
        showModalSliderForFiles(currentSavedImageObjs.map(o => o.url).concat(currentPreviewUrls));
        productModal.classList.remove('hidden');
        productModal.setAttribute('aria-hidden', 'false');
    } catch (err) {
        console.error('openEdit error', err);
        showToast('Error abriendo producto');
    }
}

// small helper to show combined slider in modal (saved + preview)
function showModalSliderForFiles(combined) {
    slideTrack.innerHTML = '';
    if (!combined || !combined.length) {
        imagePreviewSlider.classList.add('hidden');
        imagePreviewSlider.setAttribute('aria-hidden', 'true');
        return;
    }
    imagePreviewSlider.classList.remove('hidden');
    imagePreviewSlider.setAttribute('aria-hidden', 'false');
    combined.forEach(url => {
        const node = document.createElement('div');
        node.className = 'slide-item';
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'preview';
        img.loading = 'lazy';
        node.appendChild(img);
        slideTrack.appendChild(node);
    });
    slideTrack.scrollLeft = 0;
}

// handle preview selection
imageFileField.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []).slice(0, 8);
    currentPreviewFiles = currentPreviewFiles.concat(files);
    const urls = files.map(f => URL.createObjectURL(f));
    currentPreviewUrls = currentPreviewUrls.concat(urls);
    showModalSliderForFiles(currentSavedImageObjs.map(o => o.url).concat(currentPreviewUrls));
});

imageDropZone.addEventListener('click', () => imageFileField.click());
imageDropZone.addEventListener('dragover', (e) => { e.preventDefault(); imageDropZone.classList.add('dragover'); });
imageDropZone.addEventListener('dragleave', () => imageDropZone.classList.remove('dragover'));
imageDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    imageDropZone.classList.remove('dragover');
    const dtFiles = Array.from(e.dataTransfer.files || []).slice(0, 8);
    currentPreviewFiles = currentPreviewFiles.concat(dtFiles);
    const urls = dtFiles.map(f => URL.createObjectURL(f));
    currentPreviewUrls = currentPreviewUrls.concat(urls);
    showModalSliderForFiles(currentSavedImageObjs.map(o => o.url).concat(currentPreviewUrls));
});

/* ---------- Upload images helper with optimization & resumable progress ---------- */
async function uploadImagesToProductFolder(productId, files = [], baseName = 'product', maxFiles = 8, onProgress = null) {
    if (!files || !files.length) return [];
    const arr = Array.from(files).slice(0, maxFiles);

    const optimizedBlobs = [];
    for (const f of arr) {
        try {
            const b = await optimizarImagen(f, { maxWidth: 1400, maxHeight: 1400, quality: 0.8 });
            optimizedBlobs.push({ blob: b, originalName: f.name });
        } catch (e) {
            optimizedBlobs.push({ blob: f, originalName: f.name });
        }
    }

    const totalBytes = optimizedBlobs.reduce((s, it) => s + (it.blob.size || 0), 0);
    let uploadedBytes = 0;
    const uploaded = [];

    for (let i = 0; i < optimizedBlobs.length; i++) {
        const { blob, originalName } = optimizedBlobs[i];
        const safeName = `${Date.now()}_${baseName.replace(/\s+/g, '_')}_${i}_${originalName.replace(/\s+/g, '_')}`;
        const path = `products/${productId}/${safeName}`;
        const ref = storageRef(storage, path);
        const uploadTask = uploadBytesResumable(ref, blob);

        const urlObj = await new Promise((resolve, reject) => {
            uploadTask.on('state_changed',
                (snapshot) => {
                    const bytesSoFar = uploadedBytes + (snapshot.bytesTransferred || 0);
                    const overallPct = totalBytes ? (bytesSoFar / totalBytes) * 100 : 0;
                    if (onProgress) try { onProgress(overallPct); } catch (e) { }
                },
                (err) => { reject(err); },
                async () => {
                    try {
                        const durl = await getDownloadURL(uploadTask.snapshot.ref);
                        uploadedBytes += (blob.size || 0);
                        if (onProgress) try { onProgress(totalBytes ? (uploadedBytes / totalBytes) * 100 : 100); } catch (e) { }
                        resolve({ url: durl, path: uploadTask.snapshot.ref.fullPath || path });
                    } catch (gErr) { reject(gErr); }
                }
            );
        });
        uploaded.push(urlObj);
    }
    return uploaded;
}

/* ---------- Add / Update product (use image uploading) ---------- */
async function addProduct(data, files) {
    if (!currentUser) { showToast('No autenticado'); return; }
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }
    const minImages = 4;
    const filesCount = (files && files.length) ? files.length : 0;
    if (filesCount < minImages) {
        showToast(`Se requieren al menos ${minImages} imágenes (seleccionadas: ${filesCount})`, 5000);
        return;
    }
    try {
        const slug = (data.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
        const newDoc = {
            name: data.name,
            name_lower: data.name.toLowerCase(),
            slug,
            description: data.description || '',
            price: Number(data.price) || 0,
            currency: 'CLP',
            category: data.category || '',
            status: data.status || 'Activo',
            onOffer: !!data.onOffer,
            discount: Number(data.discount) || 0,
            stock: Number(data.stock) || 0,
            imageUrls: [],
            imagePaths: [],
            sku: data.sku || '',
            ownerId: currentUser.uid,
            salesCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };
        const docRef = await addDoc(productsCol, newDoc);
        const productId = docRef.id;

        // show modal progress
        createModalProgressUI();
        const uploaded = await uploadImagesToProductFolder(productId, files, data.name, 8, (pct) => updateModalProgress(pct));
        removeModalProgressUI();

        const urls = uploaded.map(x => x.url);
        const paths = uploaded.map(x => x.path);

        await updateDoc(doc(db, 'product', productId), { imageUrls: urls, imagePaths: paths, updatedAt: serverTimestamp() });
        showToast('Producto agregado con éxito');
    } catch (err) {
        removeModalProgressUI();
        console.error('addProduct error', err);
        showToast('Error al agregar producto');
    }
}

async function updateProduct(id, data, newFiles = []) {
    if (!currentUser) { showToast('No autenticado'); return; }
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }
    try {
        const prodRef = doc(db, 'product', id);
        const snap = await getDoc(prodRef);
        if (!snap.exists()) { showToast('Producto no encontrado'); return; }
        const docData = snap.data();
        let imageUrls = Array.isArray(docData.imageUrls) ? docData.imageUrls.slice() : [];
        let imagePaths = Array.isArray(docData.imagePaths) ? docData.imagePaths.slice() : [];

        // If new files, upload and append
        if (newFiles && newFiles.length) {
            createModalProgressUI();
            const uploaded = await uploadImagesToProductFolder(id, newFiles, data.name, 8, (pct) => updateModalProgress(pct));
            removeModalProgressUI();
            imageUrls = imageUrls.concat(uploaded.map(x => x.url));
            imagePaths = imagePaths.concat(uploaded.map(x => x.path));
        }

        // If any pendingDeletePaths, remove them
        if (pendingDeletePaths.length) {
            imagePaths = imagePaths.filter(p => !pendingDeletePaths.includes(p));
            // rebuild imageUrls to match remaining paths if mapping exists
            const pathToUrl = {};
            if (Array.isArray(docData.imagePaths)) {
                docData.imagePaths.forEach((p, idx) => { if (docData.imageUrls && docData.imageUrls[idx]) pathToUrl[p] = docData.imageUrls[idx]; });
            }
            if (Object.keys(pathToUrl).length) {
                imageUrls = imagePaths.map(p => pathToUrl[p]).filter(Boolean);
            } else {
                imageUrls = imageUrls.slice(0, imagePaths.length);
            }
            pendingDeletePaths = [];
        }

        const slug = (data.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
        await updateDoc(prodRef, {
            name: data.name,
            name_lower: data.name.toLowerCase(),
            slug,
            description: data.description || '',
            price: Number(data.price) || 0,
            category: data.category || '',
            status: data.status || 'Activo',
            onOffer: !!data.onOffer,
            discount: Number(data.discount) || 0,
            stock: Number(data.stock) || 0,
            imageUrls,
            imagePaths,
            sku: data.sku || '',
            updatedAt: serverTimestamp()
        });
        showToast('Producto actualizado');
    } catch (err) {
        removeModalProgressUI();
        console.error('updateProduct error', err);
        showToast('Error al actualizar producto');
    }
}

/* ---------- Delete saved image (admin) ---------- */
async function deleteSavedImageFromProduct(productId, imageObj) {
    if (!productId || !imageObj) return false;
    if (!currentUser || currentUserRole !== 'administrador') { showToast('No autorizado'); return false; }
    const path = imageObj.path || imageObj.storagePath || null;
    try {
        if (path) {
            const ref = storageRef(storage, path);
            await deleteObject(ref).catch(() => { /* ignore */ });
        }
        // Update Firestore to remove this image
        const productRef = doc(db, 'product', productId);
        const snap = await getDoc(productRef);
        if (!snap.exists()) return true;
        const data = snap.data();
        const urls = Array.isArray(data.imageUrls) ? data.imageUrls.filter(u => u !== imageObj.url) : [];
        const paths = Array.isArray(data.imagePaths) ? data.imagePaths.filter(p => p !== (imageObj.path || imageObj.path)) : [];
        await updateDoc(productRef, { imageUrls: urls, imagePaths: paths, updatedAt: serverTimestamp() });
        showToast('Imagen eliminada');
        return true;
    } catch (err) {
        console.error('deleteSavedImageFromProduct error', err);
        showToast('No se pudo eliminar imagen');
        return false;
    }
}

/* ---------- Modal progress UI (insert below dropzone) ---------- */
let modalProgressEl = null;
function createModalProgressUI() {
    removeModalProgressUI();
    modalProgressEl = document.createElement('div');
    modalProgressEl.className = 'modal-progress';
    modalProgressEl.style.marginTop = '8px';
    modalProgressEl.style.display = 'flex';
    modalProgressEl.style.flexDirection = 'column';
    modalProgressEl.style.gap = '6px';

    const barWrap = document.createElement('div');
    barWrap.style.background = '#eef2ff';
    barWrap.style.borderRadius = '8px';
    barWrap.style.height = '10px';
    barWrap.style.overflow = 'hidden';
    const bar = document.createElement('div');
    bar.style.background = '#4f46e5';
    bar.style.height = '100%';
    bar.style.width = '0%';
    bar.style.transition = 'width 150ms linear';
    barWrap.appendChild(bar);

    const statusRow = document.createElement('div');
    statusRow.style.display = 'flex';
    statusRow.style.justifyContent = 'space-between';
    statusRow.style.alignItems = 'center';
    const percentText = document.createElement('div');
    percentText.textContent = '0%';
    percentText.style.fontSize = '13px';
    percentText.style.color = '#374151';
    statusRow.appendChild(percentText);

    modalProgressEl.appendChild(barWrap);
    modalProgressEl.appendChild(statusRow);

    modalProgressEl.update = (pct) => {
        bar.style.width = `${pct}%`;
        percentText.textContent = `${Math.round(pct)}%`;
    };

    const dropRow = productModal.querySelector('#imageDropZone');
    if (dropRow && dropRow.parentNode) {
        dropRow.parentNode.insertBefore(modalProgressEl, dropRow.nextSibling);
    } else {
        productModal.querySelector('.modal-content')?.appendChild(modalProgressEl);
    }
}
function updateModalProgress(pct) { if (modalProgressEl && typeof modalProgressEl.update === 'function') modalProgressEl.update(pct); }
function removeModalProgressUI() { if (modalProgressEl && modalProgressEl.parentNode) modalProgressEl.parentNode.removeChild(modalProgressEl); modalProgressEl = null; }

/* ---------- Event listeners ---------- */
openAddBtn?.addEventListener('click', openAddModal);
closeModalBtn?.addEventListener('click', () => { productModal.classList.add('hidden'); productModal.setAttribute('aria-hidden', 'true'); clearModalPreviews(); });
cancelBtn?.addEventListener('click', () => { productModal.classList.add('hidden'); productModal.setAttribute('aria-hidden', 'true'); clearModalPreviews(); });

searchInput.addEventListener('input', applyFilters);
stateFilter.addEventListener('change', applyFilters);
offerFilter.addEventListener('change', applyFilters);

productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameField.value.trim();
    const price = priceField.value;
    const category = categoryField.value;
    if (!name) { showToast('El nombre es requerido'); return; }
    if (!category) { showToast('La categoría es requerida'); return; }
    if (price === '' || Number(price) < 0) { showToast('Precio inválido'); return; }

    if (!isEditing && !skuField.value) skuField.value = generateSKUForCategory(category);

    const data = {
        name,
        description: descriptionField.value.trim(),
        price: Number(price),
        category,
        status: statusField.value,
        onOffer: onOfferField.checked,
        discount: Number(discountField.value) || 0,
        stock: Number(stockField.value) || 0,
        sku: skuField.value || ''
    };

    const filesToUpload = currentPreviewFiles.slice();

    if (isEditing && editingId) await updateProduct(editingId, data, filesToUpload);
    else await addProduct(data, filesToUpload);

    productModal.classList.add('hidden');
    productModal.setAttribute('aria-hidden', 'true');
    clearModalPreviews();
});

/* ---------- Auth & start ---------- */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = new URL('../index.html', window.location.href).toString();
        return;
    }
    currentUser = user;
    try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserRole = userDoc.exists() ? (userDoc.data().role || 'vendedor') : 'vendedor';
        applyUiRestrictions(currentUserRole);
        startRealtimeListener();
    } catch (err) {
        console.error('Error checking role', err);
        window.location.href = new URL('../index.html', window.location.href).toString();
    }
});