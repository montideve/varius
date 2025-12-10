// assets/js/mini-rotator.js
// Rotador automático que muestra una imagen por mini-slider y cambia cada 2s.
// Debe cargarse después de product-admin.js in product.html.

const rotators = new Map();

function initRotatorFor(slider) {
    if (!slider || rotators.has(slider)) return;
    const track = slider.querySelector('.mini-track');
    if (!track) return;
    // collect srcs
    const imgs = Array.from(track.querySelectorAll('img')).map(i => i.src).filter(Boolean);
    if (!imgs.length) return;

    // clear children and insert single display
    track.innerHTML = '';
    const displayWrap = document.createElement('div'); displayWrap.className = 'mini-display';
    const displayImg = document.createElement('img'); displayImg.className = 'mini-current'; displayImg.src = imgs[0];
    displayWrap.appendChild(displayImg); track.appendChild(displayWrap);

    let idx = 0;
    const intervalId = setInterval(() => {
        idx = (idx + 1) % imgs.length;
        fadeImageTo(displayImg, imgs[idx], 240);
    }, 2000);

    rotators.set(slider, { intervalId, idx, imgs, imgEl: displayImg });
}

function fadeImageTo(imgEl, newSrc, dur = 200) {
    if (!imgEl) return;
    imgEl.style.transition = `opacity ${dur}ms ease`;
    imgEl.style.opacity = '0';
    setTimeout(() => { imgEl.src = newSrc; imgEl.style.opacity = '1'; }, dur);
}

function clearAllRotators() {
    for (const [el, info] of rotators.entries()) {
        clearInterval(info.intervalId);
        rotators.delete(el);
    }
}

document.addEventListener('products:rendered', () => {
    clearAllRotators();
    const sliders = document.querySelectorAll('.mini-slider');
    sliders.forEach(s => { try { initRotatorFor(s); } catch (e) { console.error('rotator init', e); } });
});

window.addEventListener('load', () => {
    const sliders = document.querySelectorAll('.mini-slider'); sliders.forEach(s => { try { initRotatorFor(s); } catch (e) { } });
});