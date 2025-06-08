document.addEventListener('DOMContentLoaded', function() {
  const statusButton = document.getElementById('statusButton');

  function checkConnection() {
    fetch('https://api.openai.com/v1/engines', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
    })
    .then(response => {
      if (response.ok) {
        statusButton.classList.remove('disconnected');
        statusButton.classList.add('connected');
        statusButton.textContent = 'Connected';
      } else {
        statusButton.classList.remove('connected');
        statusButton.classList.add('disconnected');
        statusButton.textContent = 'Disconnected';
      }
    })
    .catch(() => {
      statusButton.classList.remove('connected');
      statusButton.classList.add('disconnected');
      statusButton.textContent = 'Disconnected';
    });
  }

  statusButton.addEventListener('click', checkConnection);
  checkConnection(); // Initial check
});