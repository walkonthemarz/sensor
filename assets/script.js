const ctxTemp = document.getElementById('tempChart').getContext('2d');
const ctxEco2 = document.getElementById('eco2Chart').getContext('2d');

const tempChart = new Chart(ctxTemp, {
    type: 'line',
    data: {
        labels: [],
        datasets: [{
            label: 'Temperature (°C)',
            borderColor: 'rgb(255, 99, 132)',
            data: [],
            tension: 0.1
        }, {
            label: 'Humidity (%)',
            borderColor: 'rgb(54, 162, 235)',
            data: [],
            tension: 0.1
        }]
    },
    options: { responsive: true }
});

const eco2Chart = new Chart(ctxEco2, {
    type: 'line',
    data: {
        labels: [],
        datasets: [{
            label: 'eCO2 (ppm)',
            borderColor: 'rgb(75, 192, 192)',
            data: [],
            tension: 0.1
        }]
    },
    options: { responsive: true }
});

async function fetchData() {
    try {
        const response = await fetch('/api/readings');
        const data = await response.json();

        if (data.length === 0) return;

        // Update latest readings text
        const latest = data[0];
        document.getElementById('latest-readings').innerHTML = `
            <strong>Temp:</strong> ${latest.temperature.toFixed(1)}°C | 
            <strong>Hum:</strong> ${latest.humidity.toFixed(1)}% | 
            <strong>eCO2:</strong> ${latest.eco2} ppm | 
            <strong>PM2.5:</strong> ${latest.pm2_5}
        `;

        // Prepare chart data (reverse to show oldest to newest)
        const reversedData = [...data].reverse();
        const labels = reversedData.map(d => new Date(d.timestamp).toLocaleTimeString());

        tempChart.data.labels = labels;
        tempChart.data.datasets[0].data = reversedData.map(d => d.temperature);
        tempChart.data.datasets[1].data = reversedData.map(d => d.humidity);
        tempChart.update();

        eco2Chart.data.labels = labels;
        eco2Chart.data.datasets[0].data = reversedData.map(d => d.eco2);
        eco2Chart.update();

    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

// Fetch every 2 seconds
setInterval(fetchData, 2000);
fetchData();
