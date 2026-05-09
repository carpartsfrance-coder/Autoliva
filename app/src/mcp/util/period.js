'use strict';

const ALLOWED_PERIODS = new Set(['7d', '30d', '90d', '365d', 'all']);
const DEFAULT_PERIOD = '30d';

function getStartDateForPeriod(period) {
  if (period === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[period];
  if (!days) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start;
}

function getPreviousPeriodRange(period) {
  if (period === 'all') return { start: null, end: null };
  const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[period];
  if (!days) return { start: null, end: null };
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() - days);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { start, end };
}

function safePeriod(period) {
  return ALLOWED_PERIODS.has(period) ? period : DEFAULT_PERIOD;
}

module.exports = {
  ALLOWED_PERIODS,
  DEFAULT_PERIOD,
  getStartDateForPeriod,
  getPreviousPeriodRange,
  safePeriod,
};
