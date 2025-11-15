# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram bot for managing availability slots for a sauna ("баня"). The bot operates in Ukrainian and supports two user modes:
- **Client mode**: View schedule, information, and contacts
- **Admin mode**: Add/edit/delete slots, clear days, broadcast messages

The bot is designed to run alongside an older project in its own isolated folder with its own dependencies and data storage.

## Build & Run Commands

```bash
# Development (with auto-reload)
npm run dev

# Build TypeScript to JavaScript
npm run build

# Production (requires build first)
npm start
# Or using PM2 (currently used in production):
pm2 start dist/index.js --name simple-availability-bot
pm2 restart simple-availability-bot
pm2 logs simple-availability-bot
```

## Environment Configuration

Required `.env` file (copy from `.env.example`):
- `BOT_TOKEN` - Telegram bot token (required)
- `ADMIN_IDS` - Comma-separated Telegram user IDs for admin access
- `TIME_ZONE` - Default: `Europe/Kyiv`
- `DAY_OPEN_TIME` / `DAY_CLOSE_TIME` - Business hours (default: 09:00-23:00)
- `SCHEDULE_DAYS` - Days to show in schedule (default: 7)
- `SLOT_STEP_MINUTES` - Time slot intervals (default: 60, supports 30-minute slots)
- `CONTACT_MESSAGE` - Message shown to clients

## Architecture

### Core Data Flow

1. **Storage Layer** (`src/storage/`):
   - `AvailabilityStore` - JSON-based persistence for slots (`data/availability.json`)
   - `UserStore` - Tracks users who interacted with the bot (`data/users.json`)
   - No database - uses simple JSON files

2. **Service Layer** (`src/services/`):
   - `AvailabilityService` - Business logic for slot management
   - Handles slot creation, merging overlapping slots, validation
   - Minimum slot duration: 2 hours (120 minutes)
   - Latest slot start time: 22:00 (prevents slots ending after closing)
   - For current day: only shows future time slots

3. **Bot Layer** (`src/bot/`):
   - `index.ts` - Main bot setup, handlers, mode switching
   - `addSlotScene.ts` - Wizard for adding slots (4 steps with back/cancel navigation)
   - `types.ts` - Bot-specific types and session state

4. **Image Generation** (`src/core/scheduleImage.ts`):
   - Uses `@napi-rs/canvas` to generate schedule PNG
   - Color-coded slots, displays half-hour granularity
   - Shows availability with large readable fonts

### Key Concepts

**Slot Merging**: When adding overlapping or adjacent slots, they automatically merge into a single continuous slot. This prevents fragmentation of availability.

**Wizard Scene Pattern**: The slot addition flow uses Telegraf's WizardScene:
- Step 1: Select day
- Step 2: Select start time (filtered by current time if today)
- Step 3: Select end time (minimum 2 hours from start)
- Step 4: Select if sauna is available (`chanAvailable`)
- Messages are edited in-place rather than creating new ones
- Has "⬅️ Назад" (back) and "❌ Скасувати" (cancel) buttons

**Mode Switching**: Users can toggle between client and admin modes. Admin mode requires user ID to be in `ADMIN_IDS`. Mode is stored in session state.

**Callback Data Patterns**:
- `slot:view:{slotId}` - View slot details
- `slot:edit:{slotId}` - Start editing slot
- `slot:edit:start:{slotId}:{timeKey}` - Select new start time
- `slot:edit:apply:{slotId}:{startKey}:{endKey}` - Apply time changes
- `slot:delete:{slotId}` - Delete slot
- `slot:toggle:{slotId}` - Toggle sauna availability
- `admin:clear:{dateISO}` - Clear specific day
- `admin:clear:all` - Clear all days (with confirmation)

**Time Handling**:
- Uses `date-fns` and `date-fns-tz` for timezone-aware operations
- All dates stored as ISO strings (`yyyy-MM-dd`)
- Times stored as `HH:mm` format
- Timezone conversions handled in `utils/time.ts`

**Navigation Flow**:
- Admin clicks "🖼 Показати розклад" → Shows schedule image
- Image has inline button "📋 Показати всі слоти" → Opens slot list for editing
- After creating a slot, shows buttons: "✏️ Редагувати", "🗑 Видалити", "🏠 Головне меню"

## Important Implementation Details

### Regex Patterns for Callback Handlers

When adding new callback handlers, use specific patterns to avoid conflicts:
- Use `[^:]+ ` instead of `.+` to match IDs (prevents matching nested colons)
- Example: `/^slot:edit:([^:]+)$/` not `/^slot:edit:(.+)$/`
- More specific handlers should be registered before general ones

### Message Editing vs Reply

The wizard scene edits the same message throughout the flow. When editing fails (message too old, etc.), catch the error and send a new message. Example pattern:
```typescript
try {
  await ctx.telegram.editMessageText(chatId, messageId, undefined, text, keyboard);
} catch (e) {
  await ctx.reply(text, keyboard);
}
```

### Session State

Session data structure (`BotSession` in `bot/types.ts`):
- `mode`: 'client' | 'admin'
- `broadcastDraft`: string (for admin broadcast messages)
- Wizard state is separate (`AddSlotWizardState` with messageId for editing)

### Inline Keyboards

All admin interactions use inline keyboards (callback buttons), not reply keyboards. Reply keyboards are only used for:
- Main mode switching button (one button shown based on current mode)
- Admin menu buttons
- Client menu buttons

## File References

When referencing code locations in responses, use format: `filename:line_number`

Example: `src/bot/addSlotScene.ts:247` for the slot duration validation logic.

## Ukrainian Language

All user-facing text is in Ukrainian. Keep this consistent when adding new features or messages.
