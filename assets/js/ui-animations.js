/**
 * UI HELPERS - Manejo de animaciones y transiciones suaves
 * Este módulo maneja las transiciones visuales del carrito y checkout
 */

/**
 * Anima la apertura del panel de checkout
 * Agrega clase 'visible' después de quitar 'hidden' para permitir transición CSS
 */
export function showCheckoutPanel() {
    const checkoutPanel = document.getElementById('checkoutPanel');
    if (!checkoutPanel) return;

    checkoutPanel.classList.remove('hidden');

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            checkoutPanel.classList.add('visible');
        });
    });
}

/**
 * Anima el cierre del panel de checkout
 * Quita clase 'visible' primero, luego 'hidden' después de la transición
 */
export function hideCheckoutPanel() {
    const checkoutPanel = document.getElementById('checkoutPanel');
    if (!checkoutPanel) return;

    checkoutPanel.classList.remove('visible');

    setTimeout(() => {
        checkoutPanel.classList.add('hidden');
    }, 350);
}

/**
 * Minimiza el panel del carrito con animación suave
 */
export function minimizeCartPanel() {
    const cartPanel = document.getElementById('cartPanel');
    if (!cartPanel) return;

    cartPanel.classList.add('minimized');
}

/**
 * Expande el panel del carrito
 */
export function expandCartPanel() {
    const cartPanel = document.getElementById('cartPanel');
    if (!cartPanel) return;

    cartPanel.classList.remove('minimized');
}

/**
 * Toggle del estado minimizado del carrito
 */
export function toggleCartMinimize() {
    const cartPanel = document.getElementById('cartPanel');
    if (!cartPanel) return;

    cartPanel.classList.toggle('minimized');
}

/**
 * Transición suave al hacer scroll a un elemento
 */
export function smoothScrollTo(elementId, offset = 0) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const elementPosition = element.getBoundingClientRect().top;
    const offsetPosition = elementPosition + window.pageYOffset - offset;

    window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
    });
}

/**
 * Animación de entrada para modales
 */
export function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    const firstFocusable = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable) {
        firstFocusable.focus();
    }
}

/**
 * Animación de salida para modales
 */
export function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

/**
 * Maneja la transición de continuar con checkout
 * Minimiza carrito y muestra checkout con animación coordinada
 */
export function transitionToCheckout() {
    minimizeCartPanel();

    setTimeout(() => {
        showCheckoutPanel();
        smoothScrollTo('checkoutPanel', 80);
    }, 200);
}

/**
 * Maneja la transición de volver al carrito
 * Oculta checkout y expande carrito
 */
export function transitionBackToCart() {
    hideCheckoutPanel();

    setTimeout(() => {
        expandCartPanel();
        smoothScrollTo('cartPanel', 80);
    }, 200);
}

/**
 * Animación de éxito para formulario enviado
 */
export function showSuccessAnimation(elementId) {
    const element = document.getElementById(elementId);
    if (!element) return;

    element.style.transition = 'all 0.3s ease';
    element.style.transform = 'scale(1.02)';
    element.style.boxShadow = '0 20px 60px rgba(47, 162, 75, 0.2)';

    setTimeout(() => {
        element.style.transform = 'scale(1)';
        element.style.boxShadow = '';
    }, 300);
}

/**
 * Animación de error para validación de formulario
 */
export function shakeElement(elementId) {
    const element = document.getElementById(elementId);
    if (!element) return;

    element.style.animation = 'shake 0.4s ease';

    setTimeout(() => {
        element.style.animation = '';
    }, 400);
}

/**
 * Añade animación de shake al CSS si no existe
 */
function ensureShakeAnimation() {
    const styleId = 'ui-helpers-animations';

    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
      20%, 40%, 60%, 80% { transform: translateX(4px); }
    }

    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes fadeOutDown {
      from {
        opacity: 1;
        transform: translateY(0);
      }
      to {
        opacity: 0;
        transform: translateY(20px);
      }
    }

    .fade-in-up {
      animation: fadeInUp 0.3s ease;
    }

    .fade-out-down {
      animation: fadeOutDown 0.3s ease;
    }
  `;

    document.head.appendChild(style);
}

ensureShakeAnimation();

/**
 * Añade clase de animación fadeIn a elementos nuevos
 */
export function fadeInElement(element) {
    if (!element) return;

    element.classList.add('fade-in-up');

    setTimeout(() => {
        element.classList.remove('fade-in-up');
    }, 300);
}

/**
 * Remueve elemento con animación fadeOut
 */
export function fadeOutElement(element, callback) {
    if (!element) {
        if (callback) callback();
        return;
    }

    element.classList.add('fade-out-down');

    setTimeout(() => {
        element.classList.remove('fade-out-down');
        if (callback) callback();
    }, 300);
}

/**
 * Añade efecto de ripple a botones
 */
export function addRippleEffect(event) {
    const button = event.currentTarget;
    const ripple = document.createElement('span');

    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;

    ripple.style.cssText = `
    position: absolute;
    width: ${size}px;
    height: ${size}px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.3);
    left: ${x}px;
    top: ${y}px;
    pointer-events: none;
    transform: scale(0);
    animation: ripple 0.6s ease-out;
  `;

    button.style.position = 'relative';
    button.style.overflow = 'hidden';
    button.appendChild(ripple);

    setTimeout(() => {
        ripple.remove();
    }, 600);
}

const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
  @keyframes ripple {
    to {
      transform: scale(4);
      opacity: 0;
    }
  }
`;
document.head.appendChild(rippleStyle);

/**
 * Inicializa todos los event listeners para animaciones
 */
export function initUIAnimations() {
    const continueBtn = document.getElementById('continueWithData');
    if (continueBtn) {
        continueBtn.addEventListener('click', transitionToCheckout);
    }

    const backBtn = document.getElementById('backToCart');
    if (backBtn) {
        backBtn.addEventListener('click', transitionBackToCart);
    }

    const cancelBtn = document.getElementById('cancelCheckout');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', transitionBackToCart);
    }

    const minimizeBtn = document.getElementById('minimizeCartBtn');
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', toggleCartMinimize);
    }

    const allButtons = document.querySelectorAll('.btn-primary, .btn-secondary');
    allButtons.forEach(button => {
        button.addEventListener('click', addRippleEffect);
    });
}

if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUIAnimations);
    } else {
        initUIAnimations();
    }
}
