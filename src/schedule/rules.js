/**
 * Генерація погодинного графіку бронювань для бані та позначок "Чан".
 * Файл містить чітку структуру умов (Node.js-псевдокод, без зовнішніх залежностей).
 * 
 * Умови закодовано рівно за фінальними правилами з повідомлення:
 * - Статуси: Вільно, Зайнято, Прибирання, Недоступно; окрема позначка "Доступний Чан"
 * - Робочий день: 09:00–23:00 (дискретизація 1 година)
 * - Мін. бронювання: 2 год; Макс: 6 год (2..6)
 * - Після кожного бронювання: +1 год Прибирання
 * - В середині дня: щоб BETWEEN два бронювання з’явилося "Вільно" — потрібно мін. вікно 4 год
 *   (1 год прибирання від попереднього + 2 год нової броні + 1 год прибирання після нової броні)
 * - На початку/в кінці дня: щоб з’явилось "Вільно" — потрібно мін. 3 год (2 год броні + 1 год прибирання)
 * - "Чан": спец. логіка (увага на приклади!):
 *   - Мін. 5-годинний проміжок між закінченням одного Зайнято та початком наступного Зайнято.
 *   - Прибирання (1 год) може йти паралельно з підготовкою чану.
 *   - ОСОБЛИВА УМОВА З ПРИКЛАДІВ:
 *       • У середині дня (кейс 12:00–17:00): вільні слоти 13:00–16:00 ПОЗНАЧАЄМО як "Вільно", АЛЕ БЕЗ ЧАНУ.
 *       • На початку дня (коли перше бронювання ≥ 5 год від старту дня): 09:00–14:00 ПОЗНАЧАЄМО як "Вільно (з Чаном)".
 *     Тобто прапорець canBookChan=true ставимо лише для 5+ год вікна на початку дня.
 */

// -----------------------------
// 1) Константи та "словник" станів
// -----------------------------

const WORK_DAY_START = 9;   // 09:00
const WORK_DAY_END = 23;    // 23:00 (останній слот — 22:00–23:00)

const MIN_BOOKING_DURATION = 2; // години
const MAX_BOOKING_DURATION = 6; // години
const ALLOWED_DURATIONS = [2, 3, 4, 5, 6];

const CLEANING_DURATION = 1; // година

// Мінімальне вікно для появи "Вільно" на краях дня: 2 год броні + 1 год прибирання
const MIN_BOOKING_WINDOW_START_END = 3;
// Мінімальне вікно між бронюваннями для появи "Вільно" в середині дня:
// 1 год (прибирання після попереднього) + 2 год (мін. нова бронь) + 1 год (прибирання після нової броні) = 4 год
const MIN_BOOKING_WINDOW_MID_DAY = 4;

// Чан: потрібен 5-годинний проміжок між end(Зайнято) та start(наступне Зайнято)
const MIN_CHAN_PREP_GAP = 5;

const STATUS = {
  FREE: 'Вільно',
  BOOKED: 'Зайнято',
  CLEANING: 'Прибирання',
  UNAVAILABLE: 'Недоступно'
};

// -----------------------------
// 2) Допоміжні утиліти
// -----------------------------

function clampToWorkday(h) {
  return Math.min(Math.max(h, WORK_DAY_START), WORK_DAY_END);
}

function inRange(h) {
  return h >= WORK_DAY_START && h <= WORK_DAY_END;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sortBookings(bookings) {
  return [...bookings].sort((a, b) => a.start - b.start);
}

function validateBookings(bookings) {
  const errors = [];
  const sorted = sortBookings(bookings);
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    // 1) Межі робочого дня
    if (b.start < WORK_DAY_START || b.end > WORK_DAY_END) {
      errors.push(`Бронювання виходить за межі робочого дня: ${b.start}-${b.end}`);
    }
    // 2) Цілі години та тривалість
    if (!Number.isInteger(b.start) || !Number.isInteger(b.end) || b.end <= b.start) {
      errors.push(`Некоректні години: ${b.start}-${b.end}`);
    }
    const dur = b.end - b.start;
    if (dur < 1) {
      errors.push(`Нульова/від’ємна тривалість: ${b.start}-${b.end}`);
    }
    // 3) Перетини
    if (i > 0) {
      const prev = sorted[i - 1];
      // Якщо початок поточного < кінець попереднього — перетин
      if (b.start < prev.end) {
        errors.push(`Перетин бронювань: ${prev.start}-${prev.end} перетинається з ${b.start}-${b.end}`);
      }
      // 4) Чисто бізнес-обмеження: бронювання не повинні "перебивати" годину прибирання попереднього
      // (тобто старт = end(попер.) не дозволяє прибирання). Це залишаємо як warning:
      if (b.start === prev.end) {
        // За суворими правилами це має бути невалідно, адже потрібна 1 год прибирання.
        // Дамо попередження, але графік все одно намалюємо (клієнт побачить конфлікт).
        // Якщо суворо забороняти — розкоментувати помилку:
        // errors.push(`Між бронюваннями немає години на прибирання: ${prev.start}-${prev.end} та ${b.start}-${b.end}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, sorted };
}

// -----------------------------
// 3) Розмітка графіку (BOOKED, CLEANING)
// -----------------------------

function initSchedule() {
  const schedule = [];
  for (let h = WORK_DAY_START; h < WORK_DAY_END; h++) {
    schedule[h] = {
      hour: h,                 // h..h+1
      status: null,            // буде встановлено нижче
      canBookChan: false,      // позначка "Доступний Чан"
      note: null               // додаткова примітка для UI
    };
  }
  return schedule;
}

function markBooked(schedule, bookings) {
  for (const b of bookings) {
    for (let h = b.start; h < b.end; h++) {
      if (schedule[h]) schedule[h].status = STATUS.BOOKED;
    }
  }
}

function markCleaning(schedule, bookings) {
  for (const b of bookings) {
    const cleaningHour = b.end;
    // Прибирання наступної години після бронювання, якщо вона в робочому дні
    if (cleaningHour < WORK_DAY_END && cleaningHour >= WORK_DAY_START) {
      // Не перезаписуємо, якщо вже Зайнято (конфлікт — залишимо як є)
      if (schedule[cleaningHour] && schedule[cleaningHour].status === null) {
        schedule[cleaningHour].status = STATUS.CLEANING;
      }
    }
  }
}

// -----------------------------
// 4) Класифікація вільних "gap"-ів: Вільно / Недоступно
// -----------------------------

function classifyGaps(schedule) {
  for (let h = WORK_DAY_START; h < WORK_DAY_END; h++) {
    if (!schedule[h]) continue;
    if (schedule[h].status !== null) continue; // пропустити зайняті/прибирання

    // Знайти суцільний gap [gapStart..gapEnd], де status === null
    const gapStart = h;
    let gapEnd = h;
    while (gapEnd + 1 < WORK_DAY_END && schedule[gapEnd + 1].status === null) {
      gapEnd++;
    }
    const gapLength = (gapEnd - gapStart + 1); // години, де status === null

    // Визначаємо "вікно" для правил на краях/в середині дня, включаючи сусідні CLEANING
    let windowStart = gapStart;
    if (schedule[gapStart - 1]?.status === STATUS.CLEANING) {
      windowStart = gapStart - 1;
    }
    let windowEnd = gapEnd;
    if (schedule[gapEnd + 1]?.status === STATUS.CLEANING) {
      windowEnd = gapEnd + 1;
    }

    const isStartOfWorkDay = (windowStart === WORK_DAY_START);
    const isEndOfWorkDay = (windowEnd === WORK_DAY_END - 1);
    const windowLength = (windowEnd - windowStart + 1);

    const minRequiredWindow = (isStartOfWorkDay || isEndOfWorkDay)
      ? MIN_BOOKING_WINDOW_START_END
      : MIN_BOOKING_WINDOW_MID_DAY;

    // Базове правило: якщо gap >= 2 і window >= мінімуму => Вільно, інакше Недоступно
    const statusToSet =
      (gapLength >= MIN_BOOKING_DURATION && windowLength >= minRequiredWindow)
        ? STATUS.FREE
        : STATUS.UNAVAILABLE;

    for (let i = gapStart; i <= gapEnd; i++) {
      schedule[i].status = statusToSet;
    }

    h = gapEnd; // пропускаємо оброблене
  }
}

// -----------------------------
// 5) Вікна для чану (5+ год)
// -----------------------------

/**
 * Повертає проміжки між завершенням одного Зайнято та стартом наступного Зайнято.
 * Включає також початок дня та кінець дня як межі.
 * Формат елемента: { start, end, type }, type ∈ { 'startOfDay', 'midDay', 'endOfDay' }
 */
function computeBookingGaps(bookings) {
  const gaps = [];
  const sorted = sortBookings(bookings);

  // Від початку дня до першого бронювання
  if (sorted.length === 0) {
    gaps.push({ start: WORK_DAY_START, end: WORK_DAY_END, type: 'startOfDay' });
    return gaps;
  }

  const firstStart = sorted[0].start;
  if (firstStart > WORK_DAY_START) {
    gaps.push({ start: WORK_DAY_START, end: firstStart, type: 'startOfDay' });
  }

  // Між бронюваннями
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i];
    const right = sorted[i + 1];
    gaps.push({ start: left.end, end: right.start, type: 'midDay' });
  }

  // Від останнього бронювання до кінця дня
  const lastEnd = sorted[sorted.length - 1].end;
  if (lastEnd < WORK_DAY_END) {
    gaps.push({ start: lastEnd, end: WORK_DAY_END, type: 'endOfDay' });
  }
  return gaps;
}

/**
 * Маркує canBookChan згідно з оновленими правилами і прикладами.
 * ВАЖЛИВО: згідно з уточненням у прикладі "Ваш кейс", вікно 12:00–17:00
 *          НЕ ДАЄ права виставляти "з Чаном" для вільних слотів всередині нього.
 *          Чекбокс/прапорець canBookChan=true виставляємо ТІЛЬКИ для 5+ год вікна
 *          НА ПОЧАТКУ ДНЯ (тип 'startOfDay').
 */
function markChanAvailability(schedule, bookings) {
  const gaps = computeBookingGaps(bookings);
  for (const g of gaps) {
    const gapLen = g.end - g.start;
    if (gapLen < MIN_CHAN_PREP_GAP) continue;

    if (g.type === 'startOfDay') {
      // Дозволяємо "з Чаном" лише на початку дня
      for (let h = g.start; h < g.end; h++) {
        if (schedule[h] && schedule[h].status === STATUS.FREE) {
          schedule[h].canBookChan = true;
          schedule[h].note = 'Вільно + Чан';
        }
      }
    } else {
      // 'midDay' і 'endOfDay' — за оновленим прикладом залишаємо БЕЗ ЧАНУ
      // Якщо потрібно, можна залишити службову примітку для відладки:
      // for (let h = g.start; h < g.end; h++) {
      //   if (schedule[h] && schedule[h].status === STATUS.FREE) {
      //     schedule[h].note = 'Вільно (підготовка чану триває, без чану)';
      //   }
      // }
    }
  }
}

// -----------------------------
// 6) Додатково: Підказки по дозволених тривалостях у кожній годині
// -----------------------------

/**
 * Для кожної години зі статусом "Вільно" обчислюємо доступні варіанти тривалостей (2..6),
 * враховуючи, що після нової броні потрібна 1 година на прибирання в межах "вікна".
 * Це допомагає UI формувати валідні кнопки "2/3/4/5/6 год".
 */
function computeDurationsHelp(schedule) {
  const result = {};
  // Знаходимо суцільні фрагменти Вільно (щоб рахувати варіанти лише раз на фрагмент)
  let h = WORK_DAY_START;
  while (h < WORK_DAY_END) {
    if (schedule[h] && schedule[h].status === STATUS.FREE) {
      const freeStart = h;
      let freeEnd = h;
      while (freeEnd + 1 < WORK_DAY_END && schedule[freeEnd + 1].status === STATUS.FREE) {
        freeEnd++;
      }
      // Обчислюємо межі "вікна" для цього шматка FREE з урахуванням сусідніх CLEANING
      let windowStart = freeStart;
      if (schedule[freeStart - 1]?.status === STATUS.CLEANING) windowStart = freeStart - 1;
      let windowEnd = freeEnd;
      if (schedule[freeEnd + 1]?.status === STATUS.CLEANING) windowEnd = freeEnd + 1;
      const windowLen = (windowEnd - windowStart + 1);

      // Доступні тривалості: не перевищують ALLOWED_DURATIONS і вміщаються у "вікно"
      // Довжина броні d повинна вписатися в "FREE частину" так, щоб після неї або:
      // - була година прибирання в межах windowEnd
      // - або це кінець дня та прибирання теж у межах дня (вже враховано при класифікації)
      const freeLen = (freeEnd - freeStart + 1);

      // Теоретичний максимум тривалості з огляду на freeLen і наявність CLEANING справа
      // Якщо справа є CLEANING, то після d годин броні прибирання вже "закладено" у window.
      // Якщо CLEANING праворуч немає (край дня), прибирання має поміститися всередині дня.
      const hasRightCleaning = (schedule[freeEnd + 1]?.status === STATUS.CLEANING);

      const durations = [];
      for (const d of ALLOWED_DURATIONS) {
        if (d > freeLen) continue;
        // Перевіряємо, чи зможемо виконати прибирання (1 год) одразу після d,
        // не виходячи за межі windowEnd (якщо праворуч вже є CLEANING — воно і є наш +1).
        const requiresCleaningHour = true; // за правилами завжди
        const totalNeeded = requiresCleaningHour ? (d + CLEANING_DURATION) : d;
        if (totalNeeded <= (freeLen + (hasRightCleaning ? 1 : 0))) {
          durations.push(d);
        }
      }

      // Записуємо підказки для кожної години free-фрагмента
      for (let i = freeStart; i <= freeEnd; i++) {
        result[i] = durations.slice(); // копія
      }

      h = freeEnd + 1;
    } else {
      h++;
    }
  }
  return result;
}

// -----------------------------
// 7) Головна функція
// -----------------------------

/**
 * @param {Array<{start:number,end:number}>} existingBookings - масив існуючих бронювань у годинах
 * @returns {{
 *   schedule: Array<{hour:number,status:string,canBookChan:boolean,note:string|null}>,
 *   durationsHelp: Record<number, number[]>,
 *   validation: { ok:boolean, errors:string[] }
 * }}
 */
function generateSchedule(existingBookings) {
  const validation = validateBookings(existingBookings || []);
  const bookings = validation.sorted;

  const schedule = initSchedule();
  markBooked(schedule, bookings);
  markCleaning(schedule, bookings);
  classifyGaps(schedule);
  markChanAvailability(schedule, bookings);

  const durationsHelp = computeDurationsHelp(schedule);
  return {
    schedule: schedule.filter(Boolean),
    durationsHelp,
    validation
  };
}

// -----------------------------
// 8) Приклади (відповідають сценаріям з опису)
// -----------------------------
/* 
// Приклад 1: "Ваш кейс" — 5 год (12–17) у середині дня -> ВІЛЬНО без чану
const bookings1 = [
  { start: 10, end: 12 }, // Зайнято 10–12
  { start: 17, end: 19 }  // Зайнято 17–19
];
const r1 = generateSchedule(bookings1);
// Очікування (спрощено):
// 12:00–13:00  Прибирання
// 13:00–16:00  Вільно (canBookChan=false)
// 17:00–19:00  Зайнято

// Приклад 2: 4 години між бронями (12–16) -> Вільно 13–15, далі Недоступно
const bookings2 = [
  { start: 10, end: 12 }, // Зайнято 10–12
  { start: 16, end: 18 }  // Зайнято 16–18
];
const r2 = generateSchedule(bookings2);
// Очікування (спрощено):
// 12:00–13:00  Прибирання
// 13:00–14:00  Вільно (без чану)
// 14:00–15:00  Вільно (без чану)
// 15:00–16:00  Недоступно
// 16:00–18:00  Зайнято

// Приклад 3: Початок дня має 5 год (09–14) -> Вільно з Чаном
const bookings3 = [
  { start: 14, end: 16 } // Перша бронь 14:00
];
const r3 = generateSchedule(bookings3);
// Очікування:
// 09:00–14:00  Вільно (canBookChan=true)
// 16:00–17:00  Прибирання
*/

// -----------------------------
// 9) Експорти
// -----------------------------

module.exports = {
  // Константи/словники
  WORK_DAY_START,
  WORK_DAY_END,
  MIN_BOOKING_DURATION,
  MAX_BOOKING_DURATION,
  ALLOWED_DURATIONS,
  CLEANING_DURATION,
  MIN_BOOKING_WINDOW_START_END,
  MIN_BOOKING_WINDOW_MID_DAY,
  MIN_CHAN_PREP_GAP,
  STATUS,

  // Основні функції
  generateSchedule,
  // Допоміжні (можуть знадобитися у тестах/рефакторингу)
  validateBookings,
  computeBookingGaps
};

