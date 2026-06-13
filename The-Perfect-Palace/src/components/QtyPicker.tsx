// Reusable numeric quantity picker with −/+ buttons, an editable input,
// and an optional "max" shortcut. Enforces min/max/step on blur and on
// any button click. Controlled (value + onChange) — the parent owns state.

export interface QtyPickerProps {
  value: number
  min: number
  max?: number
  step?: number
  disabled?: boolean
  onChange: (next: number) => void
  /** Show a "max" button that jumps straight to the maximum. Default true when max is provided. */
  showMax?: boolean
  /** Optional id for label/for pairing. */
  id?: string
}

function clamp(v: number, min: number, max: number | undefined, step: number): number {
  const hi = max == null ? Infinity : max
  const raw = Math.max(min, Math.min(hi, Math.floor(v)))
  const offset = raw - min
  const snapped = min + Math.round(offset / step) * step
  return Math.max(min, Math.min(hi, snapped))
}

export function QtyPicker({
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
  showMax,
  id,
}: QtyPickerProps) {
  const canDecrement = !disabled && value > min
  const canIncrement = !disabled && (max == null || value + step <= max)
  const effectiveShowMax = (showMax ?? max != null) && max != null

  return (
    <div className={`qty-picker ${disabled ? 'is-disabled' : ''}`}>
      <button
        type="button"
        className="qty-btn"
        disabled={!canDecrement}
        aria-label="decrease"
        onClick={() => onChange(clamp(value - step, min, max, step))}
      >
        −
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className="qty-input"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          // Allow intermediate typing; clamp on blur.
          const n = Number(e.target.value)
          if (!Number.isFinite(n)) return
          onChange(n)
        }}
        onBlur={(e) => {
          const n = Number(e.target.value)
          onChange(clamp(Number.isFinite(n) ? n : min, min, max, step))
        }}
      />
      <button
        type="button"
        className="qty-btn"
        disabled={!canIncrement}
        aria-label="increase"
        onClick={() => onChange(clamp(value + step, min, max, step))}
      >
        +
      </button>
      {effectiveShowMax && (
        <button
          type="button"
          className="qty-max"
          disabled={disabled || value === max}
          onClick={() => onChange(clamp(max!, min, max, step))}
          title={`Max: ${max}`}
        >
          max
        </button>
      )}
    </div>
  )
}
