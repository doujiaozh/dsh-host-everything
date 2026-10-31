/**
 * builtin: clock — wall-clock & timers as a host.
 * `args[0]` selects the sub-command:
 *   - 'now'    (default) → `{iso, unix, tzOffsetMin}`
 *   - 'iso'             → ISO string only
 *   - 'stamp'           → unix millis (data) + ISO (stdout)
 *   - 'format' arg[1]   → Date.now() formatted with `toLocaleString`
 */
'use strict';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clock(params) {
  const args = params.args ?? [];
  const cmd = (args[0] || 'now').toLowerCase();
  const now = new Date();
  const iso = now.toISOString();
  const unix = now.getTime();

  switch (cmd) {
    case 'iso':
      return { ok: true, data: iso, stdout: iso };
    case 'stamp':
    case 'unix':
      return { ok: true, data: unix, stdout: String(unix) };
    case 'format': {
      const locale = args[1];
      const text = locale
        ? now.toLocaleString(locale, { timeZoneName: 'short' })
        : `${WEEKDAYS[now.getDay()]} ${now.toLocaleString()}`;
      return { ok: true, data: text, stdout: text };
    }
    case 'now':
    default:
      return {
        ok: true,
        data: { iso, unix, tzOffsetMin: -now.getTimezoneOffset(), weekday: WEEKDAYS[now.getDay()] },
        stdout: iso,
      };
  }
}

module.exports = clock;
module.exports.default = clock;
