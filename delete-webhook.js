const https = require('https');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

console.log('🔄 Видаляю webhook та скидаю pending updates...\n');

const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const result = JSON.parse(data);
    console.log('Результат:', JSON.stringify(result, null, 2));

    if (result.ok) {
      console.log('\n✅ Webhook видалено та pending updates скинуто!');
      console.log('🚀 Можна запускати: npm run dev');
    } else {
      console.log('\n⚠️ Можливо webhook не було встановлено');
      console.log('💡 Спробуйте запустити бота: npm run dev');
    }
  });
}).on('error', (err) => {
  console.error('❌ Помилка:', err.message);
});
