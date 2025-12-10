// assets/js/payment-modal.js
// Modal de cobro — soporta múltiples métodos y conversión USD/EUR <> Bs
// Cambios recientes:
// - Auto-llenado automático del monto en Bs cuando se selecciona Pago Móvil o Efectivo y hay una tasa activa.
// - Si se marca Pago Móvil, se muestra select de bancos + input de referencia; se oculta al desmarcar.
// - Si se marcan USD/PayPal y se introducen montos, el campo Pago Móvil/Efectivo se reajusta automáticamente con el faltante (salvo que el usuario haya editado manualmente ese campo).
// - Se usa un flag `data-user-edited` por campo para respetar ediciones manuales y no sobrescribirlas.
// - Ahora se guarda en Firestore TODO el contexto de la conversión y del pago:
//   * snapshot de las tasas (usd_bcv / eur_bcv) y la fuente (API o asignada)
//   * fecha/tasa usada (conversionRateDate y conversionRateSource)
//   * para cada método se guarda: currency, amount (original), bsAmount (si aplica), usdEquivalent, conversion metadata
//   * totales relacionados: totalUSD (orden), totalReceivedUSD, totalReceivedBs, totalInBsAtRate (si hay tasa)
//   * si pago móvil: banco y referencia quedan guardados
// Esto permite que la vista detallada de la orden muestre "absolutamente todo".

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    doc,
    serverTimestamp,
    runTransaction
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// DOM elementos
const modal = document.getElementById('paymentModal');
const pmCustomerName = document.getElementById('pmCustomerName');
const pmTotal = document.getElementById('pmTotal');
const pmTotalBs = document.getElementById('pmTotalBs');
const paymentForm = document.getElementById('paymentForm');
const pmReceivedEl = document.getElementById('pmReceived');
const pmErrorEl = document.getElementById('pmError');
const pmAmountCorrect = document.getElementById('pmAmountCorrect');
const pmConfirmBtn = document.getElementById('pmConfirmBtn');
const pmCancelBtn = document.getElementById('pmCancelBtn');
const pmChecksSelector = '.pm-check';
const pmAmountSelector = '.pm-amount';

const convChecksSelector = '.pm-conv-check';
const pmAssignRate = document.getElementById('pmAssignRate');
const pmAssignRateWrap = document.getElementById('pmAssignRateWrap');
const pmConvInfo = document.getElementById('pmConvInfo');
const pmApplyConversion = document.getElementById('pmApplyConversion');
const pmRemainingEl = document.getElementById('pmRemaining');

const pmMobileDetails = document.getElementById('pmMobileDetails');
const pmMobileBank = document.getElementById('pmMobileBank');
const pmMobileRef = document.getElementById('pmMobileRef');

let currentOrder = null;
let currentUser = null;

let rates = {
    usd_bcv: null, // Bs per USD for today's date
    eur_bcv: null, // Bs per EUR for today's date
    date: null,    // YYYY-MM-DD of the fetched rates
    apiSource: null,
    apiRaw: null
};

onAuthStateChanged(auth, (u) => { currentUser = u; });

/* ---------------- UI helpers ---------------- */
function showModal() {
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const firstChk = modal.querySelector(pmChecksSelector);
    if (firstChk) firstChk.focus();
}

function closeModal() {
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    cleanup();
}

function cleanup() {
    if (paymentForm) paymentForm.reset();
    if (pmReceivedEl) pmReceivedEl.textContent = '$. 0.00';
    if (pmErrorEl) { pmErrorEl.style.display = 'none'; pmErrorEl.textContent = ''; }
    pmAssignRateWrap.style.display = 'none';
    pmConvInfo.textContent = '';
    pmTotalBs.textContent = '';
    if (pmMobileDetails) pmMobileDetails.style.display = 'none';
    // reset user-edited flags
    document.querySelectorAll('.pm-amount').forEach(inp => {
        delete inp.dataset.userEdited;
    });
}

/* ---------------- Conversion / Rates ---------------- */

// Nueva API única solicitada
const EXCHANGE_API = 'https://api.dolarvzla.com/public/exchange-rate';

async function fetchRates() {
    try {
        const resp = await fetch(EXCHANGE_API);
        if (!resp.ok) {
            console.warn('fetchRates: respuesta no OK', resp.status);
            rates.usd_bcv = null;
            rates.eur_bcv = null;
            rates.date = null;
            rates.apiSource = EXCHANGE_API;
            rates.apiRaw = null;
            return;
        }
        const j = await resp.json();
        const current = j?.current;
        // keep raw payload for audit/debug (se guardará si se usa esta tasa)
        rates.apiRaw = j;
        rates.apiSource = EXCHANGE_API;

        if (!current) {
            console.warn('fetchRates: formato inesperado', j);
            rates.usd_bcv = null;
            rates.eur_bcv = null;
            rates.date = null;
            return;
        }

        const apiDate = current.date; // "YYYY-MM-DD"
        const today = new Date().toISOString().slice(0, 10);

        if (String(apiDate) !== String(today)) {
            console.warn(`fetchRates: tasa recibida para ${apiDate} (hoy ${today}) — no se usará`);
            rates.usd_bcv = null;
            rates.eur_bcv = null;
            rates.date = apiDate || null;
            return;
        }

        const usd = Number(current.usd);
        const eur = Number(current.eur);

        rates.usd_bcv = (usd && !isNaN(usd)) ? usd : null;
        rates.eur_bcv = (eur && !isNaN(eur)) ? eur : null;
        rates.date = apiDate;
    } catch (e) {
        console.warn('fetchRates error', e);
        rates.usd_bcv = null;
        rates.eur_bcv = null;
        rates.date = null;
        rates.apiRaw = null;
        rates.apiSource = EXCHANGE_API;
    }
}

/* ---------------- Conversión y cálculo ---------------- */

function parseAmountFor(method) {
    const el = document.querySelector(`.pm-amount[data-method="${method}"]`);
    const chk = document.querySelector(`.pm-check[data-method="${method}"]`);
    if (!el || !chk) return 0;
    const val = Number(el.value || 0);
    if (!chk.checked) return 0;
    return isNaN(val) ? 0 : val;
}

function getSelectedConversion() {
    const sel = document.querySelector(convChecksSelector + ':checked');
    if (!sel) return null;
    return sel.dataset.conv;
}

function getActiveRate() {
    const sel = getSelectedConversion();
    if (!sel) return null;
    if (sel === 'usd_bcv') return rates.usd_bcv || null;
    if (sel === 'eur_bcv') return rates.eur_bcv || null;
    if (sel === 'assign') {
        const v = Number(pmAssignRate.value || 0);
        return (v > 0) ? v : null;
    }
    return null;
}

function formatBs(v) {
    return `Bs. ${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computeTotalsAndUI() {
    pmErrorEl.style.display = 'none';
    pmErrorEl.textContent = '';

    // base total assumed in USD (from order)
    const totalUSD = Number(currentOrder?.total || currentOrder?.amount || currentOrder?.totalAmount || 0);

    // sum USD methods
    const usdAmount = parseAmountFor('usd');
    const paypalAmount = parseAmountFor('paypal');

    // sum Bs methods (cash, mobile, other) and convert to USD using active rate
    const cashBs = parseAmountFor('cash');
    const mobileBs = parseAmountFor('mobile');
    const otherBs = parseAmountFor('other');
    const bsTotal = cashBs + mobileBs + otherBs;

    // Only require conversion if either mobile or cash is selected
    const mobileChecked = Boolean(document.querySelector('.pm-check[data-method="mobile"]')?.checked);
    const cashChecked = Boolean(document.querySelector('.pm-check[data-method="cash"]')?.checked);

    let rate = getActiveRate();

    let bsToUsdEquivalent = null;
    if (bsTotal > 0) {
        if ((mobileChecked || cashChecked) && !rate) {
            pmErrorEl.textContent = 'Para convertir montos en Bs a USD necesitas seleccionar una opción de conversión válida (tasa del día) o asignar una tasa.';
            pmErrorEl.style.display = 'block';
            bsToUsdEquivalent = NaN;
        } else if (rate) {
            bsToUsdEquivalent = Number((bsTotal / rate));
        } else {
            bsToUsdEquivalent = 0;
        }
    } else {
        bsToUsdEquivalent = 0;
    }

    const totalReceivedUSD = (usdAmount || 0) + (paypalAmount || 0) + (isNaN(bsToUsdEquivalent) ? 0 : bsToUsdEquivalent);
    pmReceivedEl.textContent = `$. ${Number(totalReceivedUSD).toFixed(2)}`;

    const remainingUSD = Number((totalUSD - totalReceivedUSD) || 0);
    pmRemainingEl.textContent = `Resto: $. ${remainingUSD.toFixed(2)}`;

    // show total in Bs only if conversion selected and (mobile or cash selected)
    const sel = getSelectedConversion();
    if ((sel === 'usd_bcv' && rates.usd_bcv) || (sel === 'eur_bcv' && rates.eur_bcv) || sel === 'assign') {
        if (mobileChecked || cashChecked) {
            if (sel === 'usd_bcv' && rates.usd_bcv) {
                pmTotalBs.textContent = `≈ ${formatBs(totalUSD * rates.usd_bcv)} (tasa ${rates.usd_bcv} Bs/USD, fecha ${rates.date})`;
                pmConvInfo.textContent = `Tasa activa: ${rates.usd_bcv} Bs por USD (fecha ${rates.date})`;
            } else if (sel === 'eur_bcv' && rates.eur_bcv) {
                pmTotalBs.textContent = `≈ ${formatBs(totalUSD * rates.eur_bcv)} (tasa ${rates.eur_bcv} Bs/EUR, fecha ${rates.date})`;
                pmConvInfo.textContent = `Tasa activa: ${rates.eur_bcv} Bs por EUR (fecha ${rates.date})`;
            } else if (sel === 'assign') {
                const v = Number(pmAssignRate.value || 0);
                if (v > 0) {
                    pmTotalBs.textContent = `≈ ${formatBs(totalUSD * v)} (tasa asignada ${v} Bs/USD)`;
                    pmConvInfo.textContent = `Tasa asignada: ${v} Bs por USD`;
                } else {
                    pmTotalBs.textContent = '';
                    pmConvInfo.textContent = 'Ingresa una tasa personalizada válida.';
                }
            }
        } else {
            pmTotalBs.textContent = '';
            pmConvInfo.textContent = 'Selecciona Pago Móvil o Efectivo para ver el total en Bs.';
        }
    } else {
        pmTotalBs.textContent = '';
        if (rates.date) {
            pmConvInfo.textContent = `Tasas disponibles en API pero no seleccionadas o no aplican (fecha API: ${rates.date}).`;
        } else {
            pmConvInfo.textContent = 'Tasa no disponible para hoy. Selecciona "Asignar" o revisa la API.';
        }
    }

    return { totalUSD, totalReceivedUSD, remainingUSD, rate, bsTotal, bsBreakdown: { cashBs, mobileBs, otherBs }, rateSnapshot: { usd_bcv: rates.usd_bcv, eur_bcv: rates.eur_bcv, date: rates.date, source: rates.apiSource } };
}

/**
 * Convierto USD a Bs usando rate (Bs per USD).
 */
function usdToBs(usd, rate) {
    return Number((usd * rate) || 0);
}

/**
 * Convierto Bs a USD usando rate (Bs per USD).
 */
function bsToUsd(bs, rate) {
    return rate ? Number(bs / rate) : NaN;
}

/* ---------------- Auto-llenado inteligente ---------------- */

/**
 * Intenta auto-llenar el campo Pago Móvil o Efectivo con el resto convertido a Bs.
 * Respeta ediciones manuales: si el usuario editó manualmente un campo (data-user-edited="true") no lo sobrescribe.
 * Preferencia: mobile > cash.
 */
function autoFillBsIfNeeded() {
    const sel = getSelectedConversion();
    const rate = getActiveRate();
    if (!sel || !rate) return; // nada que hacer si no hay conversión válida

    const { remainingUSD } = computeTotalsAndUI();
    if (remainingUSD <= 0) return;

    const mobileChk = document.querySelector('.pm-check[data-method="mobile"]');
    const cashChk = document.querySelector('.pm-check[data-method="cash"]');
    const mobileInput = document.querySelector('.pm-amount[data-method="mobile"]');
    const cashInput = document.querySelector('.pm-amount[data-method="cash"]');

    const mobileSelected = Boolean(mobileChk && mobileChk.checked);
    const cashSelected = Boolean(cashChk && cashChk.checked);

    // nothing to do if neither selected
    if (!mobileSelected && !cashSelected) return;

    const bsAmount = Number(usdToBs(remainingUSD, rate).toFixed(2));

    // helpers to check user-edited flag
    const isUserEdited = (inp) => inp && inp.dataset && inp.dataset.userEdited === 'true';

    // Prefer mobile
    if (mobileSelected && mobileInput && !isUserEdited(mobileInput)) {
        mobileChk.checked = true;
        mobileInput.disabled = false;
        mobileInput.value = bsAmount;
        // mark as auto-filled (not user edited) so future USD changes may update again
        mobileInput.dataset.userEdited = 'false';
        if (pmMobileDetails) pmMobileDetails.style.display = 'block';
        computeTotalsAndUI();
        return;
    }

    // If mobile was edited manually, try cash
    if (cashSelected && cashInput && !isUserEdited(cashInput)) {
        cashChk.checked = true;
        cashInput.disabled = false;
        cashInput.value = bsAmount;
        cashInput.dataset.userEdited = 'false';
        computeTotalsAndUI();
        return;
    }

    // If both are selected and neither was user-edited, mobile already handled, but handle edge cases:
    // if mobile is user-edited but cash is not, fill cash (already handled).
}

/* ---------------- Events ---------------- */

document.addEventListener('change', (e) => {
    // métodos marcados/amounts
    if (e.target && (e.target.matches(pmChecksSelector) || e.target.matches(pmAmountSelector))) {
        // enable/disable amount inputs depending on checkbox
        document.querySelectorAll(pmChecksSelector).forEach(chk => {
            const method = chk.dataset.method;
            const amountInput = document.querySelector(`.pm-amount[data-method="${method}"]`);
            if (!amountInput) return;
            // if the checkbox was toggled on just now, allow auto-fill (mark as not user-edited)
            if (chk === e.target && chk.checked) {
                amountInput.disabled = false;
                // allow auto-fill (user hasn't edited yet)
                amountInput.dataset.userEdited = 'false';
            } else {
                amountInput.disabled = !chk.checked;
            }
            if (!chk.checked) {
                amountInput.value = '0';
                // clear user-edit flag
                delete amountInput.dataset.userEdited;
            }
        });

        // show/hide mobile details when mobile checkbox changed
        if (e.target && e.target.matches('.pm-check[data-method="mobile"]')) {
            const mobileChk = e.target;
            if (mobileChk.checked) {
                if (pmMobileDetails) pmMobileDetails.style.display = 'block';
                // reset bank/ref when newly checked (optional)
                // pmMobileBank.value = '';
                // pmMobileRef.value = '';
            } else {
                if (pmMobileDetails) pmMobileDetails.style.display = 'none';
                if (pmMobileBank) pmMobileBank.value = '';
                if (pmMobileRef) pmMobileRef.value = '';
            }
        }

        computeTotalsAndUI();
        // after recompute try auto-fill if appropriate
        autoFillBsIfNeeded();
    }

    // conversión: asegurar exclusividad y mostrar input asignar
    if (e.target && e.target.matches(convChecksSelector)) {
        // make them exclusive (only one at a time)
        if (e.target.checked) {
            document.querySelectorAll(convChecksSelector).forEach(c => {
                if (c !== e.target) c.checked = false;
            });
        }
        // show/hide assign input
        const sel = getSelectedConversion();
        pmAssignRateWrap.style.display = (sel === 'assign') ? 'block' : 'none';

        // If user selected usd_bcv or eur_bcv attempt to fetch API and use only if date === today
        if ((sel === 'usd_bcv' && !rates.usd_bcv) || (sel === 'eur_bcv' && !rates.eur_bcv) || !rates.date) {
            fetchRates().then(() => {
                computeTotalsAndUI();
                // try auto-fill now that we may have a rate
                autoFillBsIfNeeded();
            }).catch(() => {
                computeTotalsAndUI();
                autoFillBsIfNeeded();
            });
        } else {
            computeTotalsAndUI();
            autoFillBsIfNeeded();
        }
    }

    // assign rate manual edit
    if (e.target && e.target.id === 'pmAssignRate') {
        computeTotalsAndUI();
        autoFillBsIfNeeded();
    }
});

// aplicar conversión al Pago Móvil (rellena el campo mobile o cash en Bs) - botón manual
if (pmApplyConversion) {
    pmApplyConversion.addEventListener('click', () => {
        pmErrorEl.style.display = 'none';
        pmErrorEl.textContent = '';

        const rate = getActiveRate();
        const { remainingUSD } = computeTotalsAndUI();
        if (remainingUSD <= 0) {
            pmErrorEl.textContent = 'No hay resto para convertir.';
            pmErrorEl.style.display = 'block';
            return;
        }
        if (!rate) {
            pmErrorEl.textContent = 'Selecciona una tasa de conversión válida antes de convertir.';
            pmErrorEl.style.display = 'block';
            return;
        }

        // Force fill regardless of user-edited flags (user explicitly clicked the botón)
        const mobileChk = document.querySelector(`.pm-check[data-method="mobile"]`);
        const cashChk = document.querySelector(`.pm-check[data-method="cash"]`);
        const mobileInput = document.querySelector(`.pm-amount[data-method="mobile"]`);
        const cashInput = document.querySelector(`.pm-amount[data-method="cash"]`);
        const bsAmount = Number(usdToBs(remainingUSD, rate).toFixed(2));

        if (mobileChk && mobileChk.checked && mobileInput) {
            mobileChk.checked = true;
            mobileInput.disabled = false;
            mobileInput.value = bsAmount;
            mobileInput.dataset.userEdited = 'false';
            if (pmMobileDetails) pmMobileDetails.style.display = 'block';
            computeTotalsAndUI();
            return;
        }
        if (cashChk && cashChk.checked && cashInput) {
            cashChk.checked = true;
            cashInput.disabled = false;
            cashInput.value = bsAmount;
            cashInput.dataset.userEdited = 'false';
            computeTotalsAndUI();
            return;
        }

        pmErrorEl.textContent = 'Selecciona Pago Móvil o Efectivo antes de aplicar la conversión.';
        pmErrorEl.style.display = 'block';
    });
}

// input events: detectar cuando el usuario edita manualmente un campo (para no sobrescribirlo)
// y recalcular totales; si el usuario cambia USD/paypal, intentar auto-llenar Bs (si el target no fue editado manualmente)
document.addEventListener('input', (e) => {
    // si el usuario escribe en un amount, marcar como user-edited
    if (e.target && e.target.matches(pmAmountSelector)) {
        // mark this field as user-edited
        e.target.dataset.userEdited = 'true';
        computeTotalsAndUI();
        // If this is a USD/paypal field changing, try to auto-fill Bs target (respecting user-edited flags)
        const isUsdField = e.target.matches('.pm-amount[data-method="usd"]') || e.target.matches('.pm-amount[data-method="paypal"]');
        if (isUsdField) {
            autoFillBsIfNeeded();
        }
        return;
    }

    if (e.target && (e.target.matches('#pmAssignRate') || e.target.matches(convChecksSelector))) {
        computeTotalsAndUI();
        autoFillBsIfNeeded();
    }
});

/* ---------------- Lógica principal: abrir modal y confirmar cobranza ---------------- */

function parseItemProductIdAndQty(item) {
    const productId = item.productId || item.product || item.product_id || item.id || item.productIdRef || item._id;
    const qty = Number(item.quantity || item.qty || item.count || item.quantityOrdered || item.q || 1) || 1;
    return { productId, qty };
}

export async function openPaymentModal(orderObj) {
    if (!orderObj) return;
    currentOrder = orderObj;

    pmCustomerName.textContent = orderObj.customerData?.Customname || orderObj.customerData?.name || orderObj.clientName || orderObj.customer || '—';
    const total = orderObj.total || orderObj.amount || orderObj.totalAmount || 0;
    pmTotal.textContent = `$. ${Number(total).toFixed(2)}`;

    cleanup();
    // fetch rates in background (will use only today's rate)
    fetchRates().then(() => computeTotalsAndUI()).catch(() => computeTotalsAndUI());
    computeTotalsAndUI();
    showModal();

    // Ensure mobile details visibility according to current mobile checkbox
    const mobileChkInit = document.querySelector(`.pm-check[data-method="mobile"]`);
    if (mobileChkInit) {
        if (mobileChkInit.checked) {
            if (pmMobileDetails) pmMobileDetails.style.display = 'block';
        } else {
            if (pmMobileDetails) pmMobileDetails.style.display = 'none';
        }
    }

    pmConfirmBtn.onclick = async () => {
        try {
            pmErrorEl.style.display = 'none';
            pmErrorEl.textContent = '';

            if (!currentUser) {
                pmErrorEl.textContent = 'Usuario no autenticado.';
                pmErrorEl.style.display = 'block';
                return;
            }

            // ensure at least one method selected and amounts valid
            const methods = [];
            document.querySelectorAll(pmChecksSelector).forEach(chk => {
                if (!chk.checked) return;
                const method = chk.dataset.method;
                const amountInput = document.querySelector(`.pm-amount[data-method="${method}"]`);
                const amount = Number(amountInput?.value || 0);
                if (isNaN(amount) || amount <= 0) return;
                // currency: USD for usd/paypal, Bs for others
                const currency = (method === 'usd' || method === 'paypal') ? 'USD' : 'Bs';
                // For mobile include bank/ref if present
                const extra = {};
                if (method === 'mobile') {
                    extra.bank = pmMobileBank?.value || '';
                    extra.reference = pmMobileRef?.value || '';
                }
                methods.push({ method, amount, currency, ...extra });
            });

            if (methods.length === 0) {
                pmErrorEl.textContent = 'Selecciona al menos un método con un monto mayor a 0.';
                pmErrorEl.style.display = 'block';
                return;
            }

            // Recompute totals and validate
            const { totalUSD, totalReceivedUSD } = computeTotalsAndUI();

            // Allow small epsilon
            const EPS = 0.005;
            if (isNaN(totalReceivedUSD)) {
                pmErrorEl.textContent = 'Hay montos en Bs sin una tasa de conversión válida.';
                pmErrorEl.style.display = 'block';
                return;
            }
            if (Math.abs(totalReceivedUSD - totalUSD) > EPS) {
                pmErrorEl.textContent = `El total abonado ($${totalReceivedUSD.toFixed(2)}) no coincide con el total a cobrar ($${totalUSD.toFixed(2)}). Ajusta los montos.`;
                pmErrorEl.style.display = 'block';
                return;
            }

            // Build payment object with conversion metadata
            const convSelected = getSelectedConversion();
            const effectiveRate = getActiveRate() || null;
            const rateSource = (convSelected === 'assign') ? 'manual' : (rates.apiSource || EXCHANGE_API);
            const rateDate = rates.date || null;
            const rateSnapshot = { usd_bcv: rates.usd_bcv, eur_bcv: rates.eur_bcv, fetchedAt: rates.date, source: rates.apiSource, apiRaw: rates.apiRaw };

            // For Bs payments, compute USD equivalent at effectiveRate
            const detailedMethods = methods.map(m => {
                if (m.currency === 'Bs') {
                    const usdEquivalent = effectiveRate ? Number((m.amount / effectiveRate).toFixed(6)) : null;
                    return {
                        method: m.method,
                        currency: m.currency,
                        originalAmount: Number(m.amount), // bs amount
                        bsAmount: Number(m.amount),
                        usdEquivalent: usdEquivalent,
                        conversion: effectiveRate ? { type: convSelected, rate: effectiveRate, rateDate, rateSource } : null,
                        // preserve bank/ref if mobile
                        bank: m.bank || '',
                        reference: m.reference || ''
                    };
                } else {
                    // USD methods
                    return {
                        method: m.method,
                        currency: m.currency,
                        originalAmount: Number(m.amount), // usd amount
                        bsAmount: effectiveRate ? Number(usdToBs(m.amount, effectiveRate).toFixed(2)) : null,
                        usdEquivalent: Number(m.amount),
                        conversion: effectiveRate ? { type: convSelected, rate: effectiveRate, rateDate, rateSource } : null
                    };
                }
            });

            // totals for audit
            const totalReceivedBs = detailedMethods.reduce((acc, mm) => {
                if (mm.currency === 'Bs') return acc + (Number(mm.bsAmount || 0));
                if (mm.currency === 'USD' && mm.bsAmount) return acc + Number(mm.bsAmount || 0);
                return acc;
            }, 0);

            const totalInBsAtRate = (effectiveRate && totalUSD) ? Number((totalUSD * effectiveRate).toFixed(2)) : null;

            const paymentObj = {
                methods: detailedMethods,
                totalUSD: Number(totalUSD.toFixed(6)),               // total expected (from order) in USD (audit)
                totalReceivedUSD: Number(totalReceivedUSD.toFixed(6)),
                totalReceivedBs: Number(totalReceivedBs.toFixed(2)),
                totalInBsAtRate: totalInBsAtRate,                    // if a rate existed, snapshot of what the order equals in Bs
                conversionSelected: convSelected,
                conversionRate: effectiveRate,
                conversionRateDate: rateDate,
                conversionRateSource: rateSource,
                rateSnapshot: rateSnapshot,
                confirmedBy: currentUser.uid,
                confirmedByEmail: currentUser.email || '',
                paidAt: serverTimestamp()
            };

            // Update Firestore atomically: read order + product docs first then write
            const orderRef = doc(db, 'orders', currentOrder.id);

            try {
                await runTransaction(db, async (tx) => {
                    const orderSnap = await tx.get(orderRef);
                    if (!orderSnap.exists()) throw new Error('Pedido ya no existe.');
                    const orderData = orderSnap.data();

                    const items = orderData.items || currentOrder.items || [];
                    const prodMap = new Map();
                    for (const item of items) {
                        const { productId, qty } = parseItemProductIdAndQty(item);
                        if (!productId) continue;
                        if (!prodMap.has(productId)) prodMap.set(productId, { qty: 0, ref: doc(db, 'product', productId) });
                        const entry = prodMap.get(productId);
                        entry.qty += qty;
                    }

                    const prodEntries = Array.from(prodMap.entries());
                    const prodSnaps = [];
                    for (const [productId, { ref }] of prodEntries) {
                        const snap = await tx.get(ref);
                        prodSnaps.push({ productId, ref, snap });
                    }

                    for (const { productId, ref, snap } of prodSnaps) {
                        if (!snap.exists()) {
                            console.warn('Producto no encontrado al confirmar pago (se saltará):', productId);
                            continue;
                        }
                        const prodData = snap.data();
                        const currentStock = Number(prodData.stock || 0);
                        const orderedQty = prodMap.get(productId).qty || 0;
                        const newStock = Math.max(0, currentStock - orderedQty);
                        const newSales = (typeof prodData.salesCount === 'number' ? prodData.salesCount : 0) + orderedQty;

                        tx.update(ref, {
                            stock: newStock,
                            salesCount: newSales,
                            updatedAt: serverTimestamp()
                        });
                    }

                    // update order with payment info (audit-friendly)
                    tx.update(orderRef, {
                        paymentStatus: 'pagado',
                        payment: paymentObj,
                        paymentUpdatedAt: serverTimestamp(),
                        shippingStatus: 'entregado',
                        shippingUpdatedAt: serverTimestamp()
                    });
                });
            } catch (txErr) {
                console.error('Transaction error updating products/order:', txErr);
                pmErrorEl.textContent = `Pago registrado pero no se pudo actualizar inventario/pedido atomically: ${txErr.message || txErr}`;
                pmErrorEl.style.display = 'block';
                return;
            }

            // Emit event so UI can update
            document.dispatchEvent(new CustomEvent('payment:confirmed', { detail: { orderId: currentOrder.id } }));

            closeModal();
        } catch (err) {
            console.error('Error registrando cobranza:', err);
            let msg = 'Error registrando cobranza. Revisa la consola.';
            const code = err && err.code ? String(err.code) : '';
            if (code.includes('permission-denied')) msg = 'Acceso denegado. Revisa permisos de Firestore y tu sesión.';
            else if (code.includes('unauthenticated')) msg = 'Usuario no autenticado. Inicia sesión e intenta de nuevo.';
            else if (err && err.message) msg = err.message;
            pmErrorEl.textContent = msg;
            pmErrorEl.style.display = 'block';
        }
    };
}

if (pmCancelBtn) pmCancelBtn.addEventListener('click', () => closeModal());
if (document.getElementById('paymentModalClose')) {
    document.getElementById('paymentModalClose').addEventListener('click', () => closeModal());
}