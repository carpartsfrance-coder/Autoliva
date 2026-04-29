const crypto = require('crypto');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalPriceInt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }

  return null;
}

function slugifyKey(value) {
  const input = getTrimmedString(value);
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function normalizeInt(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function normalizeSearchText(value) {
  return getTrimmedString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isCheckoutVehicleOption(option) {
  const g = option && typeof option === 'object' ? option : null;
  if (!g || g.type !== 'text') return false;

  const haystack = [g.key, g.label, g.placeholder, g.helpText]
    .map(normalizeSearchText)
    .filter(Boolean)
    .join(' ');

  if (!haystack) return false;

  return (
    haystack.includes('vin') ||
    haystack.includes('plaque') ||
    haystack.includes('immatric') ||
    haystack.includes('vehicule') ||
    haystack.includes('vehicle')
  );
}

function getProductPageOptions(options) {
  return normalizeProductOptions(options).filter((option) => !isCheckoutVehicleOption(option));
}

function normalizeProductOptions(options) {
  const list = Array.isArray(options) ? options : [];

  const out = [];

  for (let i = 0; i < list.length; i += 1) {
    const g = list[i] && typeof list[i] === 'object' ? list[i] : null;
    if (!g) continue;

    const templateId = getTrimmedString(g.templateId);
    const label = getTrimmedString(g.label);
    const keyRaw = getTrimmedString(g.key) || slugifyKey(label) || `option_${i + 1}`;
    const key = slugifyKey(keyRaw) || `option_${i + 1}`;

    const type = getTrimmedString(g.type) === 'text' ? 'text' : 'choice';
    const required = g.required === true;

    const placeholder = getTrimmedString(g.placeholder);
    const helpText = getTrimmedString(g.helpText);

    const priceDeltaCents = normalizeInt(g.priceDeltaCents, 0);

    const group = {
      templateId,
      key,
      label: label || key,
      type,
      required,
      placeholder,
      helpText,
      priceDeltaCents,
      choices: [],
    };

    if (type === 'choice') {
      const choices = Array.isArray(g.choices) ? g.choices : [];
      const seen = new Set();

      for (let j = 0; j < choices.length; j += 1) {
        const c = choices[j] && typeof choices[j] === 'object' ? choices[j] : null;
        if (!c) continue;

        const choiceLabel = getTrimmedString(c.label);
        const choiceKeyRaw = getTrimmedString(c.key) || slugifyKey(choiceLabel) || `choix_${j + 1}`;
        const choiceKey = slugifyKey(choiceKeyRaw) || `choix_${j + 1}`;
        if (seen.has(choiceKey)) continue;
        seen.add(choiceKey);

        group.choices.push({
          key: choiceKey,
          label: choiceLabel || choiceKey,
          priceDeltaCents: normalizeInt(c.priceDeltaCents, 0),
          absolutePriceCents: normalizeOptionalPriceInt(c && c.absolutePriceCents),
          triggersCloning: c.triggersCloning === true,
        });
      }

      if (group.required && group.choices.length === 0) {
        group.required = false;
      }
    }

    out.push(group);
  }

  return out;
}

function buildOptionFromTemplate(template) {
  if (!template || typeof template !== 'object') return null;

  const normalized = normalizeProductOptions([
    {
      templateId: template._id ? String(template._id) : getTrimmedString(template.templateId),
      key: getTrimmedString(template.key),
      label: getTrimmedString(template.name || template.label),
      type: getTrimmedString(template.type),
      required: template.required === true,
      placeholder: getTrimmedString(template.placeholder),
      helpText: getTrimmedString(template.helpText),
      priceDeltaCents: normalizeInt(template.priceDeltaCents, 0),
      choices: Array.isArray(template.choices) ? template.choices : [],
    },
  ]);

  return normalized.length ? normalized[0] : null;
}

function extractOptionTemplateIds(options) {
  const normalized = normalizeProductOptions(options);
  return Array.from(new Set(normalized.map((option) => getTrimmedString(option.templateId)).filter(Boolean)));
}

function serializeProductOptions(options) {
  return JSON.stringify(normalizeProductOptions(options), null, 2);
}

function parseProductOptionsJson(jsonValue) {
  const raw = getTrimmedString(jsonValue);
  if (!raw) return { ok: true, options: [] };

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: 'Options: JSON invalide.' };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Options: le JSON doit être une liste.' };
  }

  return { ok: true, options: normalizeProductOptions(parsed) };
}

function buildSelectionFromBody(body, productOptions) {
  const source = body && typeof body === 'object' ? body : {};
  const opts = getProductPageOptions(productOptions);

  const selection = {};
  const errors = [];

  for (const g of opts) {
    const key = g && g.key ? String(g.key) : '';
    if (!key) continue;

    const fieldName = `opt_${key}`;

    if (g.type === 'choice') {
      const rawValue = getTrimmedString(source[fieldName]);
      const exists = g.choices.some((c) => c && String(c.key) === rawValue);
      const value = exists ? rawValue : '';

      if (!value && g.required) {
        errors.push(`Merci de choisir : ${g.label}`);
      }

      if (value) selection[key] = value;
      continue;
    }

    if (g.type === 'text') {
      const rawValue = getTrimmedString(source[fieldName]);
      if (!rawValue && g.required) {
        errors.push(`Merci de renseigner : ${g.label}`);
      }

      if (rawValue) selection[key] = rawValue;
      continue;
    }
  }

  return {
    ok: errors.length === 0,
    selection,
    errors,
    options: opts,
  };
}

function buildVariantKey(selection) {
  const sel = selection && typeof selection === 'object' ? selection : {};
  const keys = Object.keys(sel).sort();
  if (!keys.length) return '';

  return keys
    .map((k) => {
      const v = sel[k];
      return `${k}=${typeof v === 'string' ? v : String(v)}`;
    })
    .join('&');
}

function buildCartLineId(productId, selection) {
  const pid = getTrimmedString(productId);
  const variantKey = buildVariantKey(selection);
  const base = `${pid}|${variantKey}`;

  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 12);
  return {
    lineId: `${pid}__${hash}`,
    variantKey,
  };
}

function computeUnitPriceCents(product, selection) {
  const opts = getProductPageOptions(product && product.options ? product.options : []);
  const sel = selection && typeof selection === 'object' ? selection : {};

  const base = Number.isFinite(product && product.priceCents) ? product.priceCents : 0;
  let deltaTotal = 0;
  let absolutePriceOverride = null;

  for (const g of opts) {
    const value = Object.prototype.hasOwnProperty.call(sel, g.key) ? sel[g.key] : '';

    if (g.type === 'choice') {
      const choice = g.choices.find((c) => c && String(c.key) === String(value));
      if (choice) {
        const absolutePrice = normalizeOptionalPriceInt(choice.absolutePriceCents);
        if (absolutePrice !== null) {
          absolutePriceOverride = absolutePrice;
        } else {
          deltaTotal += normalizeInt(choice.priceDeltaCents, 0);
        }
      }
      continue;
    }

    if (g.type === 'text') {
      const hasValue = typeof value === 'string' ? value.trim() : String(value || '').trim();
      if (hasValue) deltaTotal += normalizeInt(g.priceDeltaCents, 0);
    }
  }

  const total = (absolutePriceOverride !== null ? absolutePriceOverride : base) + deltaTotal;
  return Math.max(0, Math.trunc(total));
}

/**
 * Check if a single item has a cloning option selected.
 * @param {Object} productOptions - product.options array
 * @param {Object} optionsSelection - selected options object
 * @returns {boolean}
 */
function itemHasCloning(productOpts, optionsSelection) {
  const opts = getProductPageOptions(productOpts || []);
  const sel = optionsSelection && typeof optionsSelection === 'object' ? optionsSelection : {};

  for (const g of opts) {
    if (g.type !== 'choice') continue;
    const value = Object.prototype.hasOwnProperty.call(sel, g.key) ? sel[g.key] : '';
    if (!value) continue;
    const choice = g.choices.find((c) => c && String(c.key) === String(value));
    if (choice && choice.triggersCloning) return true;
  }

  return false;
}

function hasCloningSelection(items) {
  if (!Array.isArray(items)) return false;

  for (const item of items) {
    if (!item || !item.product) continue;
    if (itemHasCloning(item.product.options, item.optionsSelection)) return true;
  }

  return false;
}

function buildOptionsDisplay(productOptions, selection) {
  const opts = getProductPageOptions(productOptions);
  const sel = selection && typeof selection === 'object' ? selection : {};

  const lines = [];

  for (const g of opts) {
    if (!g || !g.key) continue;

    const rawValue = Object.prototype.hasOwnProperty.call(sel, g.key) ? sel[g.key] : '';

    if (g.type === 'choice') {
      const choice = g.choices.find((c) => c && String(c.key) === String(rawValue));
      if (!choice) continue;
      lines.push({
        key: g.key,
        label: g.label,
        value: choice.label,
        priceDeltaCents: normalizeInt(choice.priceDeltaCents, 0),
        absolutePriceCents: normalizeOptionalPriceInt(choice.absolutePriceCents),
      });
      continue;
    }

    if (g.type === 'text') {
      const value = getTrimmedString(rawValue);
      if (!value) continue;
      lines.push({
        key: g.key,
        label: g.label,
        value,
        priceDeltaCents: normalizeInt(g.priceDeltaCents, 0),
        absolutePriceCents: null,
      });
    }
  }

  const optionsSummary = lines.length
    ? lines.map((x) => `${x.label} : ${x.value}`).join(' • ')
    : '';

  return { lines, optionsSummary };
}

module.exports = {
  normalizeProductOptions,
  getProductPageOptions,
  buildOptionFromTemplate,
  extractOptionTemplateIds,
  serializeProductOptions,
  parseProductOptionsJson,
  buildSelectionFromBody,
  buildVariantKey,
  buildCartLineId,
  computeUnitPriceCents,
  buildOptionsDisplay,
  itemHasCloning,
  hasCloningSelection,
};
