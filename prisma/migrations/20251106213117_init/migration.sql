-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tgId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "name" TEXT,
    "phone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dateStart" DATETIME NOT NULL,
    "dateEnd" DATETIME NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'BOT',
    "customerName" TEXT,
    "customerPhone" TEXT,
    "tgCustomerId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "timeZone" TEXT NOT NULL DEFAULT 'Europe/Kyiv',
    "workingDays" TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
    "dayOpenTime" TEXT NOT NULL DEFAULT '09:00',
    "dayCloseTime" TEXT NOT NULL DEFAULT '23:00',
    "allowedDurations" TEXT NOT NULL DEFAULT '2,3,4',
    "cleaningBufferMin" INTEGER NOT NULL DEFAULT 0,
    "lastUpdatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_tgId_key" ON "User"("tgId");

-- CreateIndex
CREATE INDEX "Booking_dateStart_dateEnd_idx" ON "Booking"("dateStart", "dateEnd");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");
