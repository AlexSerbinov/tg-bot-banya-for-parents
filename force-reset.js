const https = require('https');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not found in .env');
  process.exit(1);
}

console.log('🔄 Примусове закриття всіх сесій бота...');

// Step 1: Delete webhook with drop_pending_updates
const deleteWebhook = () => {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const result = JSON.parse(data);
        console.log('1️⃣ Webhook видалено:', result.description || result.ok);
        resolve(result);
      });
    }).on('error', reject);
  });
};

// Step 2: Get updates with offset=-1 to skip all pending
const skipPendingUpdates = () => {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const result = JSON.parse(data);
        console.log('2️⃣ Пропущено всі pending оновлення');
        resolve(result);
      });
    }).on('error', reject);
  });
};

// Step 3: Close current connection
const closeConnection = () => {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/close`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const result = JSON.parse(data);
        console.log('3️⃣ Поточне з\'єднання закрито:', result.description || result.ok);
        resolve(result);
      });
    }).on('error', (err) => {
      // Close може дати помилку якщо немає активного з'єднання - це нормально
      console.log('3️⃣ Немає активного з\'єднання (це нормально)');
      resolve({ ok: true });
    });
  });
};

// Step 4: Log out (nuclear option)
const logOut = () => {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/logOut`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const result = JSON.parse(data);
        console.log('4️⃣ Бот вийшов з системи:', result.description || result.ok);
        resolve(result);
      });
    }).on('error', (err) => {
      console.log('4️⃣ LogOut не потрібен');
      resolve({ ok: true });
    });
  });
};

// Run all steps
(async () => {
  try {
    await deleteWebhook();
    await new Promise(resolve => setTimeout(resolve, 1000));

    await skipPendingUpdates();
    await new Promise(resolve => setTimeout(resolve, 1000));

    await closeConnection();
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('\n✅ Всі сесії закрито!');
    console.log('⏰ Зачекайте 5-10 секунд та запустіть: npm run dev');
    process.exit(0);
  } catch (error) {
    console.error('❌ Помилка:', error.message);
    console.log('\n💡 Спробуйте зачекати 2 хвилини та запустити бота знову');
    process.exit(1);
  }
})();
