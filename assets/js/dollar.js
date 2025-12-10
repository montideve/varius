let chart = null;

// Función para formatear números con separadores de miles y decimales
function formatNumber(number) {
  return new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
}

// Función para formatear fecha
function formatDate(dateString) {
  return new Date(dateString).toLocaleString('es-VE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Función para obtener las tasas actuales
async function getCurrentRates() {
  try {
    const response = await fetch('https://ve.dolarapi.com/v1/dolares');
    if (!response.ok) throw new Error('Error al obtener las tasas actuales');
    
    const data = await response.json();
    const oficial = data.find(rate => rate.fuente === 'oficial');
    const paralelo = data.find(rate => rate.fuente === 'paralelo');
    const bitcoin = data.find(rate => rate.fuente === 'bitcoin');
    
    // Actualizar tasas oficiales
    document.getElementById('official-rate').innerHTML = `
      <span class="display-4">Bs. ${formatNumber(oficial.promedio)}</span>
      <div class="text-muted small">Actualizado: ${formatDate(oficial.fechaActualizacion)}</div>
    `;
    
    // Actualizar tasa paralela
    document.getElementById('parallel-rate').innerHTML = `
      <span class="display-4">Bs. ${formatNumber(paralelo.promedio)}</span>
      <div class="text-muted small">Actualizado: ${formatDate(paralelo.fechaActualizacion)}</div>
    `;

    // Actualizar tasa bitcoin
    document.getElementById('bitcoin-rate').innerHTML = `
      <span class="display-4">Bs. ${formatNumber(bitcoin.promedio)}</span>
      <div class="text-muted small">Actualizado: ${formatDate(bitcoin.fechaActualizacion)}</div>
    `;

    document.getElementById('error-message').classList.add('d-none');
  } catch (error) {
    console.error('Error:', error);
    document.getElementById('error-message').textContent = 'Error al obtener las tasas actuales. Por favor, intente más tarde.';
    document.getElementById('error-message').classList.remove('d-none');
  }
}

// Inicialización
async function init() {
  await getCurrentRates();
  
  // Actualizar tasas cada 5 minutos
  setInterval(getCurrentRates, 5 * 60 * 1000);
}

init();