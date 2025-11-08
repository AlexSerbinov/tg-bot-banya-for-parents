const https = require('https');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

console.log('🔴 УВАГА: Виконую logOut - це відключить бота від всіх серверів Telegram');
console.log('⏰ Після цього потрібно буде зачекати 30-60 секунд перед запуском\n');

const url = `https://api.telegram.org/bot${BOT_TOKEN}/logOut`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const result = JSON.parse(data);
    console.log('Результат:', JSON.stringify(result, null, 2));

    if (result.ok) {
      console.log('\n✅ Бот вийшов з системи!');
      console.log('⏰ Зачекайте 30-60 секунд');
      console.log('🚀 Потім запустіть: npm run dev');
    } else {
      console.log('\n⚠️ LogOut не вдався, але можливо це не проблема');
      console.log('💡 Спробуйте просто зачекати 2-3 хвилини та запустити бота');
    }
  });
}).on('error', (err) => {
  console.error('❌ Помилка:', err.message);
});
