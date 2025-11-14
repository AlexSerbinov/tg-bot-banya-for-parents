#!/bin/bash

# Універсальний скрипт для перезапуску Telegram бота
# Вбиває процес, перебудовує і запускає знову

echo "🔄 Restarting Telegram Bot..."

# Шукаємо і вбиваємо процес бота
BOT_PID=$(ps aux | grep "node.*dist/index.js" | grep -v grep | awk '{print $2}')

if [ ! -z "$BOT_PID" ]; then
    echo "🛑 Killing bot process PID: $BOT_PID"
    kill $BOT_PID
    sleep 2
else
    echo "ℹ️  No running bot process found"
fi

# Перебудовуємо проект
echo "🔨 Building project..."
npm run build

if [ $? -eq 0 ]; then
    echo "✅ Build successful"
    # Запускаємо бота
    echo "🚀 Starting bot..."
    npm start
else
    echo "❌ Build failed!"
    exit 1
fi