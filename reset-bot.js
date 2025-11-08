const https = require('https');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not found in .env');
  process.exit(1);
}

// Delete webhook
const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('✅ Webhook deleted:', JSON.parse(data));
    console.log('✅ Bot reset complete. You can now start the bot.');
    process.exit(0);
  });
}).on('error', (err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
