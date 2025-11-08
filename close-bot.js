const https = require('https');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

console.log('🔄 Закриваю активну сесію (close)...\n');

const url = `https://api.telegram.org/bot${BOT_TOKEN}/close`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const result = JSON.parse(data);
    console.log('Результат:', JSON.stringify(result, null, 2));

    if (result.ok) {
      console.log('\n✅ Сесія закрита!');
      console.log('⏰ Зачекайте 10-15 секунд');
      console.log('🚀 Потім запустіть: npm run dev');
    } else {
      console.log('\n⚠️ Помилка:', result.description);
      console.log('💡 Можливо потрібно почекати ще трохи або створити новий токен');
    }
  });
}).on('error', (err) => {
  console.error('❌ Помилка:', err.message);
});
