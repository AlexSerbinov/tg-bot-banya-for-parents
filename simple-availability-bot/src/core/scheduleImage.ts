import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { addMinutes, format } from 'date-fns';
import { uk } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { AvailabilitySlot, ScheduleSettings } from '../types';
import { dateToISO, toDateAtTime } from '../utils/time';

const CANVAS_WIDTH = 1200;
const CARD_MARGIN = 32;
const HEADER_HEIGHT = 176;
const HEADER_BOTTOM_MARGIN = 28;
const LEGEND_HEIGHT = 64;
const LEGEND_BOTTOM_MARGIN = 32;
const LEFT_MARGIN = 72;
const RIGHT_MARGIN = 72;
const ROW_LABEL_WIDTH = 150;
const COLUMN_GAP = 20;
const ROW_HEIGHT = 36;
const ROW_GAP = 12;
const BOARD_PADDING_LEFT = 32;
const BOARD_PADDING_RIGHT = 32;
const BOARD_PADDING_TOP = 32;
const BOARD_PADDING_BOTTOM = 40;
const DAY_HEADER_HEIGHT = 70;
const BOTTOM_PADDING = 72;

type SlotStatus = 'available' | 'booked' | 'past';

interface SlotCell {
  status: SlotStatus;
  rowIndex: number;
  slotStart: Date;
  slotEnd: Date;
}

interface SlotSegment {
  status: SlotStatus;
  startRow: number;
  endRow: number;
  slotStart: Date;
  slotEnd: Date;
}

export interface WeeklyScheduleImageResult {
  buffer: Buffer;
  stats: Record<SlotStatus, number>;
}

interface GenerateImageArgs {
  days: Date[];
  settings: ScheduleSettings;
  availability: AvailabilitySlot[];
  aggregateSlots?: boolean;
}

export function generateAvailabilityImage({
  days,
  settings,
  availability,
  aggregateSlots = true,
}: GenerateImageArgs): WeeklyScheduleImageResult {
  if (!days.length) {
    throw new Error('Не передано жодного дня для генерації розкладу');
  }

  const hourLabels = buildHourLabels(settings.dayOpenTime, settings.dayCloseTime);
  const layout = buildLayout(days.length, hourLabels.length);
  const canvasHeight = layout.canvasHeight;
  const canvas = createCanvas(CANVAS_WIDTH, canvasHeight);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, CANVAS_WIDTH, canvasHeight);
  drawCard(ctx, canvasHeight);
  drawHeader(ctx, days, settings);
  drawLegend(ctx, HEADER_HEIGHT + HEADER_BOTTOM_MARGIN);
  drawBoardContainer(ctx, layout);
  drawRowLabels(ctx, hourLabels, layout.gridY, layout.rowHeightWithGap);
  drawGrid(ctx, layout, days.length, hourLabels.length);
  drawDayHeaders(ctx, days, layout, settings.timeZone);

  const availabilityByDay = groupAvailability(availability, settings.timeZone);
  const stats: Record<SlotStatus, number> = {
    available: 0,
    booked: 0,
    past: 0,
  };

  const now = new Date();
  const dayCells = days.map(() => [] as SlotCell[]);

  days.forEach((day, columnIndex) => {
    const iso = dateToISO(day);
    hourLabels.forEach((label, rowIndex) => {
      const status = resolveSlotStatus(
        iso,
        label,
        settings,
        availabilityByDay,
        now
      );
      stats[status] += 1;

      const slotStart = toDateAtTime(iso, label, settings.timeZone);
      const slotEnd = addMinutes(slotStart, 60);

      dayCells[columnIndex].push({
        status,
        rowIndex,
        slotStart,
        slotEnd,
      });
    });
  });

  const timeZone = settings.timeZone;

  dayCells.forEach((cells, columnIndex) => {
    const columnX = layout.gridX + columnIndex * (layout.columnWidth + COLUMN_GAP);

    if (!aggregateSlots) {
      cells.forEach((cell) => {
        const cellY = layout.gridY + cell.rowIndex * (ROW_HEIGHT + ROW_GAP);
        drawSlotCell(ctx, columnX, cellY, layout.columnWidth, ROW_HEIGHT, cell.status);
        const lines = [buildRangeLabel(cell.slotStart, cell.slotEnd, timeZone)];
        const showStatus = getDurationMinutes(cell.slotStart, cell.slotEnd) > 60;
        drawSlotLabel(
          ctx,
          columnX,
          cellY,
          layout.columnWidth,
          ROW_HEIGHT,
          cell.status,
          lines,
          showStatus
        );
      });
      return;
    }

    const segments = buildSegments(cells);
    segments.forEach((segment) => {
      const rowCount = segment.endRow - segment.startRow;
      const cellY = layout.gridY + segment.startRow * (ROW_HEIGHT + ROW_GAP);
      const segmentHeight =
        rowCount * ROW_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP;
      drawSlotCell(ctx, columnX, cellY, layout.columnWidth, segmentHeight, segment.status);
      drawSlotLabel(
        ctx,
        columnX,
        cellY,
        layout.columnWidth,
        segmentHeight,
        segment.status,
        [buildRangeLabel(segment.slotStart, segment.slotEnd, timeZone)],
        getDurationMinutes(segment.slotStart, segment.slotEnd) > 60
      );
    });
  });

  const buffer = canvas.toBuffer('image/png');
  console.log(`🖼  Availability image generated (${buffer.length} bytes)`);
  return { buffer, stats };
}

function drawBackground(ctx: SKRSContext2D, width: number, height: number) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#020617');
  gradient.addColorStop(1, '#030b1c');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawHeader(ctx: SKRSContext2D, days: Date[], settings: ScheduleSettings) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const titleY = CARD_MARGIN + 8;

  ctx.font = '700 48px "Arial"';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText('Вільні години бані', LEFT_MARGIN, titleY);

  const rangeLabel = formatRange(days, settings.timeZone);
  ctx.font = '600 28px "Arial"';
  ctx.fillStyle = '#c7d2fe';
  ctx.fillText(`Період: ${rangeLabel}`, LEFT_MARGIN, titleY + 56);

  const workingHoursLabel = `Графік роботи: ${settings.dayOpenTime} – ${settings.dayCloseTime}`;
  ctx.font = '500 22px "Arial"';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(workingHoursLabel, LEFT_MARGIN, titleY + 96);

  drawWeekToggle(ctx, rangeLabel);
}

function drawLegend(ctx: SKRSContext2D, top: number) {
  const items = [
    { color: '#4ade80', label: 'Вільно' },
    { color: '#f87171', label: 'Зайнято' },
    { color: '#334155', label: 'Минуло' },
  ];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 22px "Arial"';

  let currentX = LEFT_MARGIN;
  const centerY = top + LEGEND_HEIGHT / 2 - 6;

  items.forEach((item) => {
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(currentX + 8, centerY, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#cbd5f5';
    ctx.fillText(item.label, currentX + 24, centerY);

    currentX += 24 + ctx.measureText(item.label).width + 48;
  });
}

function drawCard(ctx: SKRSContext2D, canvasHeight: number) {
  const cardX = CARD_MARGIN;
  const cardY = CARD_MARGIN;
  const cardWidth = CANVAS_WIDTH - CARD_MARGIN * 2;
  const cardHeight = canvasHeight - CARD_MARGIN * 2;

  ctx.save();
  ctx.shadowColor = 'rgba(2,6,23,0.45)';
  ctx.shadowBlur = 40;
  ctx.fillStyle = '#0b1426';
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 36);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(148,163,184,0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 36);
  ctx.stroke();
  ctx.restore();
}

function drawBoardContainer(ctx: SKRSContext2D, layout: ReturnType<typeof buildLayout>) {
  ctx.save();
  ctx.shadowColor = 'rgba(15,23,42,0.55)';
  ctx.shadowBlur = 32;
  const gradient = ctx.createLinearGradient(
    layout.boardX,
    layout.boardY,
    layout.boardX,
    layout.boardY + layout.boardHeight
  );
  gradient.addColorStop(0, '#0c1426');
  gradient.addColorStop(1, '#050b18');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect(layout.boardX, layout.boardY, layout.boardWidth, layout.boardHeight, 32);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(148,163,184,0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(layout.boardX, layout.boardY, layout.boardWidth, layout.boardHeight, 32);
  ctx.stroke();
  ctx.restore();
}

function drawWeekToggle(ctx: SKRSContext2D, rangeLabel: string) {
  const width = 280;
  const height = 70;
  const x = CANVAS_WIDTH - RIGHT_MARGIN - width;
  const y = CARD_MARGIN + 4;

  ctx.save();
  ctx.fillStyle = 'rgba(15,23,42,0.9)';
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(148,163,184,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 28);
  ctx.stroke();

  // Toggle knob
  const knobX = x + 20;
  const knobY = y + height / 2 - 16;
  ctx.fillStyle = '#020817';
  ctx.beginPath();
  ctx.roundRect(knobX, knobY, 52, 32, 16);
  ctx.fill();

  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(knobX + 34, knobY + 16, 12, 0, Math.PI * 2);
  ctx.fill();

  ctx.textBaseline = 'top';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 14px "Arial"';
  ctx.fillText('ПОТОЧНИЙ ТИЖДЕНЬ', x + 86, y + 12);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 20px "Arial"';
  ctx.fillText(rangeLabel, x + 86, y + 38);
  ctx.restore();
}

function drawRowLabels(ctx: SKRSContext2D, labels: string[], gridY: number, rowHeightWithGap: number) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '600 20px "Arial"';
  ctx.fillStyle = '#5f6f94';

  labels.forEach((label, index) => {
    const y = gridY + index * rowHeightWithGap + ROW_HEIGHT / 2;
    ctx.fillText(label, LEFT_MARGIN + ROW_LABEL_WIDTH - 16, y);
  });
}

function drawGrid(
  ctx: SKRSContext2D,
  layout: ReturnType<typeof buildLayout>,
  daysCount: number,
  rowsCount: number
) {
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1;

  for (let row = 0; row <= rowsCount; row += 1) {
    const y = layout.gridY + row * (ROW_HEIGHT + ROW_GAP) - ROW_GAP / 2;
    ctx.beginPath();
    ctx.moveTo(layout.gridX, y);
    ctx.lineTo(layout.gridX + layout.gridWidth, y);
    ctx.stroke();
  }

  for (let col = 0; col <= daysCount; col += 1) {
    const x = layout.gridX + col * (layout.columnWidth + COLUMN_GAP) - COLUMN_GAP / 2;
    ctx.beginPath();
    ctx.moveTo(x, layout.gridY);
    ctx.lineTo(x, layout.gridY + layout.gridHeight);
    ctx.stroke();
  }
}

function drawDayHeaders(
  ctx: SKRSContext2D,
  days: Date[],
  layout: ReturnType<typeof buildLayout>,
  timeZone: string
) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const startY = layout.boardY + BOARD_PADDING_TOP;

  days.forEach((day, index) => {
    const centerX =
      layout.gridX +
      index * (layout.columnWidth + COLUMN_GAP) +
      layout.columnWidth / 2;
    const dayName = formatDateInZone(day, timeZone, 'EEE').toUpperCase();
    const dateLabel = formatDateInZone(day, timeZone, 'd MMM');

    const pillX =
      layout.gridX + index * (layout.columnWidth + COLUMN_GAP) - COLUMN_GAP / 4;
    const pillWidth = layout.columnWidth + COLUMN_GAP / 2;
    ctx.fillStyle = 'rgba(6,11,20,0.85)';
    ctx.beginPath();
    ctx.roundRect(pillX, startY - 14, pillWidth, DAY_HEADER_HEIGHT - 10, 20);
    ctx.fill();

    ctx.font = '600 16px "Arial"';
    ctx.fillStyle = '#8fa3d1';
    ctx.fillText(dayName, centerX, startY);

    ctx.font = '700 20px "Arial"';
    ctx.fillStyle = '#f5f7ff';
    ctx.fillText(dateLabel, centerX, startY + 24);
  });
}

function drawSlotCell(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  status: SlotStatus
) {
  let fillStyle: CanvasGradient | string;
  if (status === 'available') {
    const gradient = ctx.createLinearGradient(x, y, x, y + height);
    gradient.addColorStop(0, '#6ee7b7');
    gradient.addColorStop(1, '#34d399');
    fillStyle = gradient;
  } else if (status === 'booked') {
    const gradient = ctx.createLinearGradient(x, y, x, y + height);
    gradient.addColorStop(0, '#f87171');
    gradient.addColorStop(1, '#ef4444');
    fillStyle = gradient;
  } else {
    const gradient = ctx.createLinearGradient(x, y, x, y + height);
    gradient.addColorStop(0, '#1f2937');
    gradient.addColorStop(1, '#111827');
    fillStyle = gradient;
  }

  ctx.save();
  ctx.fillStyle = fillStyle;
  ctx.shadowColor =
    status === 'available'
      ? 'rgba(16,185,129,0.4)'
      : status === 'booked'
        ? 'rgba(239,68,68,0.35)'
        : 'rgba(15,23,42,0.4)';
  ctx.shadowBlur = status === 'past' ? 18 : 26;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 24);
  ctx.fill();
  ctx.restore();
}

function drawSlotLabel(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  status: SlotStatus,
  lines: string[],
  showStatus: boolean
) {
  const labels: Record<SlotStatus, string> = {
    available: 'Вільно',
    booked: 'ЗАЙНЯТО',
    past: 'МИНУЛО',
  };

  const textLines = [...lines.filter(Boolean)];
  if (showStatus) {
    textLines.push(labels[status]);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (status === 'past') {
    ctx.fillStyle = '#cbd5f5';
  } else if (status === 'available') {
    ctx.fillStyle = '#052f1c';
  } else {
    ctx.fillStyle = '#f8fafc';
  }

  const maxWidth = width - 24;
  const heights: number[] = [];
  const fonts: string[] = [];

  textLines.forEach((line, index) => {
    const baseSize = index === textLines.length - 1 ? 32 : 24;
    const weight = index === textLines.length - 1 ? 700 : 600;
    let size = baseSize;
    let font = `${weight} ${size}px "Arial"`;
    ctx.font = font;

    while (ctx.measureText(line).width > maxWidth && size > 14) {
      size -= 1;
      font = `${weight} ${size}px "Arial"`;
      ctx.font = font;
    }
    fonts.push(font);
    heights.push(size + 6);
  });

  const totalHeight =
    heights.reduce((acc, h) => acc + h, 0) + Math.max(0, textLines.length - 1) * 4;
  let currentY = y + height / 2 - totalHeight / 2 + heights[0] / 2;

  textLines.forEach((line, index) => {
    ctx.font = fonts[index];
    ctx.fillText(line, x + width / 2, currentY);
    currentY += heights[index] + 4;
  });
}

function buildRangeLabel(start: Date, end: Date, timeZone: string): string {
  const startLabel = formatTimeInZone(start, timeZone);
  const endLabel = formatTimeInZone(end, timeZone);
  return `${startLabel} – ${endLabel}`;
}

function formatRange(days: Date[], timeZone: string): string {
  if (days.length === 1) {
    return formatDateInZone(days[0], timeZone, 'd MMM');
  }
  const first = formatDateInZone(days[0], timeZone, 'd MMM');
  const last = formatDateInZone(days[days.length - 1], timeZone, 'd MMM');
  return `${first} – ${last}`;
}

function formatTimeInZone(date: Date, timeZone: string): string {
  const zoned = toZonedTime(date, timeZone);
  return format(zoned, 'HH:mm', { locale: uk });
}

function formatDateInZone(date: Date, timeZone: string, pattern: string): string {
  const zoned = toZonedTime(date, timeZone);
  return format(zoned, pattern, { locale: uk });
}

function buildHourLabels(openTime: string, closeTime: string): string[] {
  const openMinutes = timeToMinutes(openTime);
  const closeMinutes = timeToMinutes(closeTime);
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

function getDurationMinutes(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 60000;
}

function buildLayout(daysCount: number, rowsCount: number) {
  const gridX = LEFT_MARGIN + ROW_LABEL_WIDTH;
  const availableWidth = CANVAS_WIDTH - gridX - RIGHT_MARGIN;
  const columnWidth =
    (availableWidth - COLUMN_GAP * Math.max(0, daysCount - 1)) / daysCount;
  const gridWidth = columnWidth * daysCount + COLUMN_GAP * Math.max(0, daysCount - 1);

  const rowHeightWithGap = ROW_HEIGHT + ROW_GAP;
  const gridHeight = rowsCount * ROW_HEIGHT + Math.max(0, rowsCount - 1) * ROW_GAP;
  const boardY = HEADER_HEIGHT + HEADER_BOTTOM_MARGIN + LEGEND_HEIGHT + LEGEND_BOTTOM_MARGIN;
  const gridY = boardY + BOARD_PADDING_TOP + DAY_HEADER_HEIGHT;
  const boardX = LEFT_MARGIN - BOARD_PADDING_LEFT;
  const boardWidth = ROW_LABEL_WIDTH + gridWidth + BOARD_PADDING_LEFT + BOARD_PADDING_RIGHT;
  const boardHeight = gridHeight + BOARD_PADDING_TOP + BOARD_PADDING_BOTTOM + DAY_HEADER_HEIGHT;
  const canvasHeight = boardY + boardHeight + BOTTOM_PADDING;

  return {
    canvasHeight,
    gridX,
    gridY,
    gridWidth,
    gridHeight,
    columnWidth,
    rowHeightWithGap,
    boardX,
    boardY,
    boardWidth,
    boardHeight,
  };
}

function groupAvailability(availability: AvailabilitySlot[], timeZone: string) {
  const map = new Map<string, Array<{ start: Date; end: Date }>>();
  availability.forEach((slot) => {
    const start = toDateAtTime(slot.dateISO, slot.startTime, timeZone);
    const end = toDateAtTime(slot.dateISO, slot.endTime, timeZone);
    if (!map.has(slot.dateISO)) {
      map.set(slot.dateISO, []);
    }
    map.get(slot.dateISO)!.push({ start, end });
  });

  map.forEach((entries) => {
    entries.sort((a, b) => a.start.getTime() - b.start.getTime());
  });

  return map;
}

function resolveSlotStatus(
  iso: string,
  timeStr: string,
  settings: ScheduleSettings,
  availability: Map<string, Array<{ start: Date; end: Date }>>,
  now: Date
): SlotStatus {
  const slotStart = toDateAtTime(iso, timeStr, settings.timeZone);
  const slotEnd = addMinutes(slotStart, 60);

  if (slotEnd <= now) {
    return 'past';
  }

  const slots = availability.get(iso) ?? [];
  const isFree = slots.some((entry) => slotStart >= entry.start && slotEnd <= entry.end);
  return isFree ? 'available' : 'booked';
}

function buildSegments(cells: SlotCell[]): SlotSegment[] {
  const segments: SlotSegment[] = [];
  let current: SlotSegment | null = null;

  cells.forEach((cell) => {
    if (current && current.status === cell.status) {
      current.endRow = cell.rowIndex + 1;
      current.slotEnd = cell.slotEnd;
      return;
    }

    if (current) {
      segments.push(current);
    }

    current = {
      status: cell.status,
      startRow: cell.rowIndex,
      endRow: cell.rowIndex + 1,
      slotStart: cell.slotStart,
      slotEnd: cell.slotEnd,
    };
  });

  if (current) {
    segments.push(current);
  }

  return segments;
}
