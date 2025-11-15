import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { addMinutes, format } from 'date-fns';
import { uk } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { performance } from 'node:perf_hooks';
import { AvailabilitySlot, ScheduleSettings } from '../types';
import { dateToISO, toDateAtTime } from '../utils/time';

const CANVAS_WIDTH = 1200;
const CARD_MARGIN = 32;
const HEADER_HEIGHT = 176;
const HEADER_BOTTOM_MARGIN = 28;
const LEGEND_HEIGHT = 64;
const LEGEND_BOTTOM_MARGIN = 32;
const LEFT_MARGIN = 52;
const RIGHT_MARGIN = 72;
const ROW_LABEL_WIDTH = 80;
const COLUMN_GAP = 18; // ширина проміжку між колонками днів
const BASE_ROW_HEIGHT = 54; // висота однієї клітинки в рядку (збільшено з 36 до 54)
const BASE_ROW_GAP = 16; // пухлість - зменшено з 24 до 16 для компактності
const BOARD_PADDING_LEFT = 2; // відступи всередині борду
const BOARD_PADDING_RIGHT = 32;
const BOARD_PADDING_TOP = 32;
const BOARD_PADDING_BOTTOM = 40;
const DAY_HEADER_HEIGHT = 70;
const BOTTOM_PADDING = 72;
const GRID_MINUTE_STEP = 30;


type SlotStatus = 'available' | 'available_with_chan' | 'booked';

interface TimeTick {
  timeString: string;
  label: string;
}

interface SlotCell {
  status: SlotStatus;
  rowIndex: number;
  slotStart: Date;
  slotEnd: Date;
  chanAvailable?: boolean;
}

interface SlotSegment {
  status: SlotStatus;
  startRow: number;
  endRow: number;
  slotStart: Date;
  slotEnd: Date;
  chanAvailable?: boolean;
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
  const perfStart = performance.now();
  if (!days.length) {
    throw new Error('Не передано жодного дня для генерації розкладу');
  }

  const layoutStart = performance.now();
  const timeTicks = buildTimeTicks(settings.dayOpenTime, settings.dayCloseTime);
  const layout = buildLayout(days.length, timeTicks.length);
  logStep('layout prepared', layoutStart);
  const canvasHeight = layout.canvasHeight;
  const canvas = createCanvas(CANVAS_WIDTH, canvasHeight);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, CANVAS_WIDTH, canvasHeight);
  drawCard(ctx, canvasHeight);
  drawHeader(ctx, days, settings);
  drawLegend(ctx, HEADER_HEIGHT + HEADER_BOTTOM_MARGIN);
  drawBoardContainer(ctx, layout);
  drawRowLabels(ctx, timeTicks, layout.gridY, layout.rowHeightWithGap, layout.rowHeight);
  drawGrid(ctx, layout, days.length, timeTicks.length);
  drawDayHeaders(ctx, days, layout, settings.timeZone);

  const groupingStart = performance.now();
  const availabilityByDay = groupAvailability(availability, settings.timeZone);
  logStep('group availability', groupingStart);
  const stats: Record<SlotStatus, number> = {
    available: 0,
    available_with_chan: 0,
    booked: 0,
  };

  const now = new Date();
  const dayCells = days.map(() => [] as SlotCell[]);

  const populateStart = performance.now();
  days.forEach((day, columnIndex) => {
    const iso = dateToISO(day);
    timeTicks.forEach((tick, rowIndex) => {
      const status = resolveSlotStatus(
        iso,
        tick.timeString,
        settings,
        availabilityByDay,
        now
      );
      stats[status] += 1;

      const slotStart = toDateAtTime(iso, tick.timeString, settings.timeZone);
      const slotEnd = addMinutes(slotStart, GRID_MINUTE_STEP);

      const slotInfo = (availabilityByDay.get(iso) ?? []).find(
        (entry) => slotStart >= entry.start && slotEnd <= entry.end
      );

      // Для зайнятих слотів не встановлюємо chanAvailable, щоб вони об'єднувалися
      const chanAvailable = status === 'booked' ? undefined : slotInfo?.chanAvailable;

      dayCells[columnIndex].push({
        status,
        rowIndex,
        slotStart,
        slotEnd,
        chanAvailable,
      });
    });
  });
  logStep('populate cells', populateStart);

  const timeZone = settings.timeZone;

  const drawStart = performance.now();
  dayCells.forEach((cells, columnIndex) => {
    const columnX = layout.gridX + columnIndex * (layout.columnWidth + COLUMN_GAP);

    if (!aggregateSlots) {
      cells.forEach((cell) => {
        const cellY = layout.gridY + cell.rowIndex * (layout.rowHeight + layout.rowGap);
        drawSlotCell(ctx, columnX, cellY, layout.columnWidth, layout.rowHeight, cell.status);
        const lines = [buildRangeLabel(cell.slotStart, cell.slotEnd, timeZone)];
        const showStatus = getDurationMinutes(cell.slotStart, cell.slotEnd) > 60;
        drawSlotLabel(
          ctx,
          columnX,
          cellY,
          layout.columnWidth,
          layout.rowHeight,
          cell.status,
          lines,
          showStatus,
          cell.chanAvailable
        );
      });
      return;
    }

    const segments = buildSegments(cells);
    segments.forEach((segment) => {
      const rowCount = segment.endRow - segment.startRow;
      const cellY = layout.gridY + segment.startRow * (layout.rowHeight + layout.rowGap);
      const segmentHeight =
        rowCount * layout.rowHeight + Math.max(0, rowCount - 1) * layout.rowGap;
      drawSlotCell(ctx, columnX, cellY, layout.columnWidth, segmentHeight, segment.status);
      const lines = [buildRangeLabel(segment.slotStart, segment.slotEnd, timeZone)];
      drawSlotLabel(
        ctx,
        columnX,
        cellY,
        layout.columnWidth,
        segmentHeight,
        segment.status,
        lines,
        getDurationMinutes(segment.slotStart, segment.slotEnd) > 60,
        segment.chanAvailable
      );
    });
  });
  logStep('draw columns', drawStart);

  const buffer = canvas.toBuffer('image/png');
  console.log(
    `🖼  Availability image generated (${buffer.length} bytes) in ${(
      performance.now() - perfStart
    ).toFixed(1)}ms`
  );
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
  const titleY = CARD_MARGIN + 28;

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
    { color: '#4ade80', label: 'Вільно (баня)' },
    { color: '#22d3ee', label: 'Вільно (баня + чан)' },
    { color: '#f87171', label: 'Зайнято' },
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
  const width = 340;
  const height = 70;
  const x = CANVAS_WIDTH - RIGHT_MARGIN - width;
  const y = CARD_MARGIN + 18;

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

function drawRowLabels(
  ctx: SKRSContext2D,
  ticks: TimeTick[],
  gridY: number,
  rowHeightWithGap: number,
  rowHeight: number
) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '600 20px "Arial"';
  ctx.fillStyle = '#5f6f94';

  ticks.forEach((tick, index) => {
    if (!tick.label) return;
    const y = gridY + index * rowHeightWithGap + rowHeight / 2;
    ctx.fillText(tick.label, LEFT_MARGIN + ROW_LABEL_WIDTH - 16, y);
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
    const y = layout.gridY + row * (layout.rowHeight + layout.rowGap) - layout.rowGap / 2;
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
    const dayName = formatDateInZone(day, timeZone, 'EEEEEE').toUpperCase();
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
  } else if (status === 'available_with_chan') {
    const gradient = ctx.createLinearGradient(x, y, x, y + height);
    gradient.addColorStop(0, '#67e8f9');
    gradient.addColorStop(1, '#22d3ee');
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
      : status === 'available_with_chan'
        ? 'rgba(34,211,238,0.4)'
        : status === 'booked'
          ? 'rgba(239,68,68,0.35)'
          : 'rgba(15,23,42,0.4)';
  ctx.shadowBlur = 26;
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
  showStatus: boolean,
  chanAvailable?: boolean
) {
  const textLines = [...lines.filter(Boolean)];

  if (showStatus) {
    if (status === 'booked') {
      textLines.push('ЗАЙНЯТО');
    } else if (status === 'available') {
      textLines.push('Вільно · баня');
      textLines.push('(без чану)');
    } else if (status === 'available_with_chan') {
      textLines.push('Вільно · баня');
      textLines.push('+ чан');
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (status === 'available') {
    ctx.fillStyle = '#052f1c';
  } else if (status === 'available_with_chan') {
    ctx.fillStyle = '#083344';
  } else {
    ctx.fillStyle = '#f8fafc';
  }

  const maxWidth = width - 7; // Зменшили відступи з 24 до 16
  const heights: number[] = [];
  const fonts: string[] = [];

  // Знаходимо мінімальний розмір, який підходить для ВСІХ рядків
  const baseSize = 48; // Збільшили з 28 до 34
  const weight = 600;
  let finalSize = baseSize;

  // Перевіряємо кожен рядок і знаходимо мінімальний розмір
  for (const line of textLines) {
    let size = baseSize;
    let font = `${weight} ${size}px "Arial"`;
    ctx.font = font;

    while (ctx.measureText(line).width > maxWidth && size > 14) {
      size -= 1;
      font = `${weight} ${size}px "Arial"`;
      ctx.font = font;
    }

    // Запам'ятовуємо найменший розмір
    if (size < finalSize) {
      finalSize = size;
    }
  }

  // Застосовуємо однаковий розмір до всіх рядків
  const finalFont = `${weight} ${finalSize}px "Arial"`;
  textLines.forEach(() => {
    fonts.push(finalFont);
    heights.push(finalSize + 6);
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

function buildTimeTicks(openTime: string, closeTime: string): TimeTick[] {
  const openMinutes = timeToMinutes(openTime);
  const closeMinutes = timeToMinutes(closeTime);
  const ticks: TimeTick[] = [];
  for (let minutes = openMinutes; minutes < closeMinutes; minutes += GRID_MINUTE_STEP) {
    ticks.push({
      timeString: minutesToLabel(minutes),
      label: minutes % 60 === 0 ? minutesToLabel(minutes) : '',
    });
  }

  // Додаємо час закриття (23:00) як останній label
  ticks.push({
    timeString: closeTime,
    label: closeTime,
  });

  return ticks;
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

function logStep(label: string, start: number) {
  const duration = (performance.now() - start).toFixed(1);
  console.log(`[ScheduleImage] ${label}: ${duration}ms`);
}

function buildLayout(daysCount: number, rowsCount: number) {
  const stepRatio = GRID_MINUTE_STEP / 60;
  const rowHeight = BASE_ROW_HEIGHT * stepRatio;
  const rowGap = BASE_ROW_GAP * stepRatio;
  const gridX = LEFT_MARGIN + ROW_LABEL_WIDTH;
  const availableWidth = CANVAS_WIDTH - gridX - RIGHT_MARGIN;
  const columnWidth =
    (availableWidth - COLUMN_GAP * Math.max(0, daysCount - 1)) / daysCount;
  const gridWidth = columnWidth * daysCount + COLUMN_GAP * Math.max(0, daysCount - 1);

  const rowHeightWithGap = rowHeight + rowGap;
  const gridHeight = rowsCount * rowHeight + Math.max(0, rowsCount - 1) * rowGap;
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
    rowHeight,
    rowGap,
    boardX,
    boardY,
    boardWidth,
    boardHeight,
  };
}

function groupAvailability(availability: AvailabilitySlot[], timeZone: string) {
  const map = new Map<string, Array<{ start: Date; end: Date; chanAvailable: boolean }>>();
  availability.forEach((slot) => {
    const start = toDateAtTime(slot.dateISO, slot.startTime, timeZone);
    const end = toDateAtTime(slot.dateISO, slot.endTime, timeZone);
    if (!map.has(slot.dateISO)) {
      map.set(slot.dateISO, []);
    }
    map.get(slot.dateISO)!.push({ start, end, chanAvailable: slot.chanAvailable !== false });
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
  availability: Map<string, Array<{ start: Date; end: Date; chanAvailable: boolean }>>,
  now: Date
): SlotStatus {
  const slotStart = toDateAtTime(iso, timeStr, settings.timeZone);
  const slotEnd = addMinutes(slotStart, GRID_MINUTE_STEP);

  // Минулі слоти показуємо як зайняті
  if (slotEnd <= now) {
    return 'booked';
  }

  const slots = availability.get(iso) ?? [];
  const freeSlot = slots.find((entry) => slotStart >= entry.start && slotEnd <= entry.end);

  if (!freeSlot) {
    return 'booked';
  }

  // Якщо чан доступний - синій, інакше - зелений
  return freeSlot.chanAvailable ? 'available_with_chan' : 'available';
}

function buildSegments(cells: SlotCell[]): SlotSegment[] {
  const segments: SlotSegment[] = [];
  let current: SlotSegment | null = null;

  cells.forEach((cell) => {
    if (current && current.status === cell.status && current.chanAvailable === cell.chanAvailable) {
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
      chanAvailable: cell.chanAvailable,
    };
  });

  if (current) {
    segments.push(current);
  }

  return segments;
}
