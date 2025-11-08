import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { Booking, Settings } from '@prisma/client';
import { addMinutes, format, isBefore } from 'date-fns';
import { uk } from 'date-fns/locale';
import { overlapsWithBuffer } from './rules';
import { dateToISO, toDateAtTime } from './time';

type SlotStatus = 'available' | 'booked' | 'past';

interface GenerateImageArgs {
  days: Date[];
  settings: Settings;
  bookings: Booking[];
}

export interface WeeklyScheduleImageResult {
  buffer: Buffer;
  stats: Record<SlotStatus, number>;
}

const CANVAS_WIDTH = 1080;
const HEADER_HEIGHT = 132;
const LEGEND_HEIGHT = 68;
const LEFT_MARGIN = 36;
const RIGHT_MARGIN = 36;
const ROW_LABEL_WIDTH = 120;
const COLUMN_GAP = 12;
const ROW_HEIGHT = 58;
const ROW_GAP = 12;
const BOTTOM_PADDING = 46;

export function generateWeeklyScheduleImage({
  days,
  settings,
  bookings,
}: GenerateImageArgs): WeeklyScheduleImageResult {
  if (!days.length) {
    throw new Error('Expected at least one day to build schedule image');
  }

  const hourLabels = buildHourLabels(settings.dayOpenTime, settings.dayCloseTime);
  if (!hourLabels.length) {
    throw new Error('Робочі години закороткі для побудови розкладу');
  }

  const gridTop = HEADER_HEIGHT + LEGEND_HEIGHT;
  const gridHeight =
    hourLabels.length * ROW_HEIGHT + Math.max(0, hourLabels.length - 1) * ROW_GAP;
  const canvasHeight = gridTop + gridHeight + BOTTOM_PADDING;

  const canvas = createCanvas(CANVAS_WIDTH, canvasHeight);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, CANVAS_WIDTH, canvasHeight);
  drawHeader(ctx, days);
  drawLegend(ctx);

  const layout = computeGridLayout(days.length);
  drawDayHeaders(ctx, days, layout, gridTop);
  drawRowLabels(ctx, hourLabels, layout, gridTop);

  const stats: Record<SlotStatus, number> = {
    available: 0,
    booked: 0,
    past: 0,
  };

  const dayDescriptors = days.map((day) => ({
    iso: dateToISO(day),
    label: format(day, 'EEE', { locale: uk }),
    dateLabel: format(day, 'd MMM', { locale: uk }),
  }));

  const now = new Date();

  dayDescriptors.forEach((day, columnIndex) => {
    hourLabels.forEach((timeLabel, rowIndex) => {
      const status = resolveSlotStatus(
        day.iso,
        timeLabel,
        settings,
        bookings,
        now
      );

      stats[status] += 1;

      const cellX =
        layout.gridX + columnIndex * (layout.columnWidth + layout.columnGap);
      const cellY = gridTop + rowIndex * (ROW_HEIGHT + ROW_GAP);

      drawSlotCell(ctx, cellX, cellY, layout.columnWidth, ROW_HEIGHT, status);
      drawSlotLabel(ctx, cellX, cellY, layout.columnWidth, ROW_HEIGHT, status);
    });
  });

  return { buffer: canvas.toBuffer('image/png'), stats };
}

type CanvasCtx = SKRSContext2D;

function drawBackground(ctx: CanvasCtx, width: number, height: number) {
  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#1d2434');
  gradient.addColorStop(1, '#141927');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, HEADER_HEIGHT);
}

function drawHeader(ctx: CanvasCtx, days: Date[]) {
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 48px "Arial"';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Вільні слоти', LEFT_MARGIN, 26);

  const rangeLabel = formatRange(days);
  ctx.font = '600 30px "Arial"';
  ctx.fillStyle = '#93c5fd';
  ctx.fillText(rangeLabel, LEFT_MARGIN, 84);
}

function drawLegend(ctx: CanvasCtx) {
  const legendItems: { color: string; label: string }[] = [
    { color: '#22c55e', label: 'Вільно' },
    { color: '#f87171', label: 'Зайнято' },
    { color: '#475569', label: 'Минуло' },
  ];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 24px "Arial"';

  let currentX = LEFT_MARGIN;
  const centerY = HEADER_HEIGHT + LEGEND_HEIGHT / 2 - 4;

  legendItems.forEach((item) => {
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.roundRect(currentX, centerY - 16, 48, 32, 12);
    ctx.fill();

    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(item.label, currentX + 58, centerY);

    currentX += 58 + ctx.measureText(item.label).width + 40;
  });
}

function computeGridLayout(dayCount: number) {
  const gridX = LEFT_MARGIN + ROW_LABEL_WIDTH;
  const availableWidth = CANVAS_WIDTH - gridX - RIGHT_MARGIN;
  const columnGap = dayCount > 1 ? COLUMN_GAP : 0;
  const columnWidth =
    dayCount > 0
      ? (availableWidth - columnGap * Math.max(0, dayCount - 1)) / dayCount
      : availableWidth;

  return { gridX, columnWidth, columnGap };
}

function drawDayHeaders(
  ctx: CanvasCtx,
  days: Date[],
  layout: { gridX: number; columnWidth: number; columnGap: number },
  gridTop: number
) {
  const headersY = gridTop - 42;
  const datesY = gridTop - 14;

  days.forEach((day, index) => {
    const centerX =
      layout.gridX + index * (layout.columnWidth + layout.columnGap) +
      layout.columnWidth / 2;

    const dayLabel = capitalize(format(day, 'EEE', { locale: uk }));
    const dateLabel = format(day, 'd MMM', { locale: uk });

    ctx.fillStyle = '#f1f5f9';
    ctx.font = '700 26px "Arial"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dayLabel, centerX, headersY);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 22px "Arial"';
    ctx.fillText(dateLabel, centerX, datesY);
  });
}

function drawRowLabels(
  ctx: CanvasCtx,
  hourLabels: string[],
  layout: { gridX: number },
  gridTop: number
) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '700 24px "Arial"';
  ctx.fillStyle = '#cbd5f5';

  hourLabels.forEach((time, rowIndex) => {
    const centerY = gridTop + rowIndex * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
    ctx.fillText(time, layout.gridX - 16, centerY);
  });
}

function drawSlotCell(
  ctx: CanvasCtx,
  x: number,
  y: number,
  width: number,
  height: number,
  status: SlotStatus
) {
  const colors: Record<SlotStatus, string> = {
    available: '#1ea672',
    booked: '#ef4444',
    past: '#334155',
  };

  ctx.fillStyle = colors[status];
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 16);
  ctx.fill();
}

function drawSlotLabel(
  ctx: CanvasCtx,
  x: number,
  y: number,
  width: number,
  height: number,
  status: SlotStatus
) {
  const labels: Record<SlotStatus, { text: string; color: string }> = {
    available: { text: 'Вільно', color: '#052e16' },
    booked: { text: 'Зайнято', color: '#fee2e2' },
    past: { text: 'Минуло', color: '#e2e8f0' },
  };

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 22px "Arial"';
  ctx.fillStyle = labels[status].color;
  ctx.fillText(labels[status].text, x + width / 2, y + height / 2 + 2);
}

function resolveSlotStatus(
  dateISO: string,
  timeStr: string,
  settings: Settings,
  bookings: Booking[],
  now: Date
): SlotStatus {
  const slotStart = toDateAtTime(dateISO, timeStr, settings.timeZone);
  const slotEnd = addMinutes(slotStart, 60);

  if (isBefore(slotEnd, now)) {
    return 'past';
  }

  const hasConflict = bookings.some((booking) =>
    overlapsWithBuffer(
      slotStart,
      slotEnd,
      booking.dateStart,
      booking.dateEnd,
      settings.cleaningBufferMin
    )
  );

  return hasConflict ? 'booked' : 'available';
}

function buildHourLabels(openTime: string, closeTime: string): string[] {
  const openMinutes = timeToMinutes(openTime);
  const closeMinutes = timeToMinutes(closeTime);

  if (closeMinutes <= openMinutes) {
    return [];
  }

  const labels: string[] = [];
  for (let minutes = openMinutes; minutes < closeMinutes; minutes += 60) {
    labels.push(minutesToLabel(minutes));
  }
  return labels;
}

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map((n) => parseInt(n, 10));
  return hours * 60 + minutes;
}

function minutesToLabel(totalMinutes: number): string {
  const hrs = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (totalMinutes % 60).toString().padStart(2, '0');
  return `${hrs}:${mins}`;
}

function formatRange(days: Date[]): string {
  if (days.length === 1) {
    return format(days[0], 'd MMM', { locale: uk });
  }

  const first = format(days[0], 'd MMM', { locale: uk });
  const last = format(days[days.length - 1], 'd MMM', { locale: uk });
  return `${first} – ${last}`;
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value[0].toUpperCase() + value.slice(1);
}
