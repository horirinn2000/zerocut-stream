-- CreateTable
CREATE TABLE `IndieGame` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(191) NOT NULL,
    `steamAppId` VARCHAR(191) NOT NULL,
    `storeUrl` VARCHAR(191) NOT NULL,
    `retailPriceJpy` INTEGER NOT NULL,
    `developerName` VARCHAR(191) NOT NULL,
    `developerContact` VARCHAR(191) NULL,
    `isOperatorAffiliated` BOOLEAN NOT NULL DEFAULT false,
    `isApproved` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `IndieGame_steamAppId_key`(`steamAppId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VideoCostLedger` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `youtubeVideoId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `gameId` INTEGER NOT NULL,
    `isSyntheticContent` BOOLEAN NOT NULL DEFAULT true,
    `llmModelName` VARCHAR(191) NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `inputRateUsdPer1M` DECIMAL(10, 4) NOT NULL DEFAULT 0.0000,
    `outputRateUsdPer1M` DECIMAL(10, 4) NOT NULL DEFAULT 0.0000,
    `usdJpyRate` DECIMAL(10, 4) NOT NULL DEFAULT 0.0000,
    `llmCostJpy` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `ttsCostJpy` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `computeCostJpy` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `totalGenerationCost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `recordingGameCostJpy` INTEGER NOT NULL DEFAULT 0,
    `recordingGameReceiptUrl` VARCHAR(191) NULL,
    `footageSource` ENUM('HUMAN_PLAY', 'SECONDARY_CLIP', 'BOT_PLAY') NOT NULL DEFAULT 'HUMAN_PLAY',
    `rawFootageSha256` VARCHAR(191) NULL,
    `rawFootageSec` INTEGER NOT NULL DEFAULT 0,
    `playRegionCode` VARCHAR(191) NOT NULL DEFAULT 'JP',
    `playMinutes` INTEGER NOT NULL DEFAULT 0,
    `playLaborRateJpyPerHour` INTEGER NOT NULL DEFAULT 0,
    `playLaborCostJpy` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `reviewRegionCode` VARCHAR(191) NOT NULL DEFAULT 'JP',
    `reviewMinutes` INTEGER NOT NULL DEFAULT 0,
    `reviewLaborRateJpyPerHour` INTEGER NOT NULL DEFAULT 0,
    `reviewLaborCostJpy` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `aiDisclosureSet` BOOLEAN NOT NULL DEFAULT false,
    `contentIdStatus` ENUM('CLEAR', 'CLAIMED_REVENUE_REDIRECTED', 'RESTRICTED') NOT NULL DEFAULT 'CLEAR',
    `viewCountSnapshot` BIGINT NULL,
    `viewCountSnapshottedAt` DATETIME(3) NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VideoCostLedger_youtubeVideoId_key`(`youtubeVideoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MonthlySettlement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `yearMonth` VARCHAR(191) NOT NULL,
    `entryCutoffAt` DATETIME(3) NOT NULL,
    `drandChainHash` VARCHAR(191) NOT NULL,
    `committedDrandRound` BIGINT NOT NULL,
    `carryOverFromPrevJpy` INTEGER NOT NULL DEFAULT 0,
    `grossAdRevenueJpy` INTEGER NOT NULL DEFAULT 0,
    `webHostingCostJpy` INTEGER NOT NULL DEFAULT 0,
    `totalInfraCostJpy` INTEGER NOT NULL DEFAULT 0,
    `totalLaborCostJpy` INTEGER NOT NULL DEFAULT 0,
    `paidLaborCostJpy` INTEGER NOT NULL DEFAULT 0,
    `ownerProfitJpy` INTEGER NOT NULL DEFAULT 0,
    `netBuybackPoolJpy` INTEGER NOT NULL DEFAULT 0,
    `totalKeysPurchased` INTEGER NOT NULL DEFAULT 0,
    `totalSpentOnKeysJpy` INTEGER NOT NULL DEFAULT 0,
    `carryOverToNextJpy` INTEGER NOT NULL DEFAULT 0,
    `adRevenueEvidenceUrl` VARCHAR(191) NULL,
    `entriesSnapshotHash` VARCHAR(191) NULL,
    `publicRandomSeed` VARCHAR(191) NULL,
    `drandSignature` VARCHAR(191) NULL,
    `isSettled` BOOLEAN NOT NULL DEFAULT false,
    `settledAt` DATETIME(3) NULL,

    UNIQUE INDEX `MonthlySettlement_yearMonth_key`(`yearMonth`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SettlementGameAllocation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `settlementId` INTEGER NOT NULL,
    `gameId` INTEGER NOT NULL,
    `publicViewCount` BIGINT NOT NULL,
    `allocatedBudgetJpy` INTEGER NOT NULL,
    `unitRetailPriceJpy` INTEGER NOT NULL,
    `keysPurchased` INTEGER NOT NULL,
    `spentJpy` INTEGER NOT NULL,
    `remainderJpy` INTEGER NOT NULL,
    `purchaseChannel` ENUM('DIRECT_FROM_DEVELOPER', 'STEAM_STORE_GIFT') NOT NULL DEFAULT 'DIRECT_FROM_DEVELOPER',
    `purchaseReceiptUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SettlementGameAllocation_settlementId_gameId_key`(`settlementId`, `gameId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ViewerUser` (
    `id` VARCHAR(191) NOT NULL,
    `authProvider` VARCHAR(191) NOT NULL,
    `authProviderId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ViewerUser_authProviderId_key`(`authProviderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MonthlyLotteryEntry` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `settlementId` INTEGER NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `isWinner` BOOLEAN NOT NULL DEFAULT false,
    `wonSteamKeyId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `MonthlyLotteryEntry_wonSteamKeyId_key`(`wonSteamKeyId`),
    UNIQUE INDEX `MonthlyLotteryEntry_settlementId_userId_key`(`settlementId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SteamKeyInventory` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `settlementId` INTEGER NOT NULL,
    `allocationId` INTEGER NOT NULL,
    `gameId` INTEGER NOT NULL,
    `encryptedSteamKey` VARCHAR(191) NOT NULL,
    `purchasePriceJpy` INTEGER NOT NULL,
    `isDistributed` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VideoCostLedger` ADD CONSTRAINT `VideoCostLedger_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `IndieGame`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SettlementGameAllocation` ADD CONSTRAINT `SettlementGameAllocation_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `MonthlySettlement`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SettlementGameAllocation` ADD CONSTRAINT `SettlementGameAllocation_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `IndieGame`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MonthlyLotteryEntry` ADD CONSTRAINT `MonthlyLotteryEntry_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `MonthlySettlement`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MonthlyLotteryEntry` ADD CONSTRAINT `MonthlyLotteryEntry_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `ViewerUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MonthlyLotteryEntry` ADD CONSTRAINT `MonthlyLotteryEntry_wonSteamKeyId_fkey` FOREIGN KEY (`wonSteamKeyId`) REFERENCES `SteamKeyInventory`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SteamKeyInventory` ADD CONSTRAINT `SteamKeyInventory_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `MonthlySettlement`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SteamKeyInventory` ADD CONSTRAINT `SteamKeyInventory_allocationId_fkey` FOREIGN KEY (`allocationId`) REFERENCES `SettlementGameAllocation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SteamKeyInventory` ADD CONSTRAINT `SteamKeyInventory_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `IndieGame`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddSingleRowCheckConstraints (MySQL 8.0.16+ enforced single-row invariants; cross-row conservation is enforced in settlement.ts)
ALTER TABLE `MonthlySettlement` ADD CONSTRAINT `chk_zero_owner_profit` CHECK (`ownerProfitJpy` = 0);
ALTER TABLE `MonthlySettlement` ADD CONSTRAINT `chk_labor_cost_bounds` CHECK (`totalLaborCostJpy` >= 0 AND `paidLaborCostJpy` >= 0 AND `paidLaborCostJpy` <= `totalLaborCostJpy`);
ALTER TABLE `SettlementGameAllocation` ADD CONSTRAINT `chk_allocation_row_bounds` CHECK (`allocatedBudgetJpy` >= 0 AND `unitRetailPriceJpy` > 0 AND `keysPurchased` >= 0 AND `spentJpy` >= 0 AND `remainderJpy` >= 0 AND `spentJpy` + `remainderJpy` = `allocatedBudgetJpy`);
