/**
 * 极小的 JSON Schema 校验器：够用就好，不引 ajv。
 *
 * 只支持这些工具实际用到的关键字（type/properties/required/enum/minimum/maximum/
 * minLength/maxLength/default/additionalProperties/items）。好处有两个：
 *   1) 零依赖——客户端只给一条命令就能跑；
 *   2) 报错文案是中文、面向模型的（「limit 不能大于 50」），模型读了知道怎么改。
 *
 * 数字接受数字字符串（"20"）：模型偶尔会把数字写成字符串，这属于能自动纠正的小毛病，
 * 不值得让整次调用失败。
 */

export function validateArguments(schema, input) {
  const errors = []
  const value = walk(schema, input, '', errors)
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

const kindOf = value => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)

function walk(schema, input, path, errors) {
  const label = path || '参数'
  if (!schema || typeof schema !== 'object') return input

  if (schema.type === 'object') {
    if (kindOf(input) !== 'object') { errors.push(`${label} 必须是对象`); return {} }
    const properties = schema.properties || {}
    const required = new Set(schema.required || [])
    const out = {}
    for (const [key, spec] of Object.entries(properties)) {
      const present = Object.prototype.hasOwnProperty.call(input, key)
      const raw = present ? input[key] : undefined
      if (!present || raw === undefined || raw === null || raw === '') {
        if (spec.default !== undefined) out[key] = spec.default
        else if (required.has(key) && !present) errors.push(`${label} 缺少必填项 ${key}`)
        else if (required.has(key) && (raw === null || raw === '')) errors.push(`${label} 的 ${key} 不能为空`)
        continue
      }
      const checked = walk(spec, raw, key, errors)
      if (checked !== undefined) out[key] = checked
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(input)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${label} 不接受未知字段 ${key}`)
      }
    }
    return out
  }

  if (schema.type === 'string') {
    if (typeof input !== 'string') { errors.push(`${label} 必须是字符串`); return undefined }
    const out = input.trim()
    if (schema.minLength !== undefined && out.length < schema.minLength) {
      errors.push(`${label} 不能为空`)
      return undefined
    }
    if (schema.enum && !schema.enum.includes(out)) {
      errors.push(`${label} 只能是 ${schema.enum.join(' / ')}`)
      return undefined
    }
    return schema.maxLength !== undefined ? out.slice(0, schema.maxLength) : out
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    const numeric = typeof input === 'number' ? input
      : typeof input === 'string' && input.trim() !== '' && Number.isFinite(Number(input)) ? Number(input) : NaN
    if (!Number.isFinite(numeric)) { errors.push(`${label} 必须是数字`); return undefined }
    if (schema.type === 'integer' && !Number.isInteger(numeric)) { errors.push(`${label} 必须是整数`); return undefined }
    if (schema.minimum !== undefined && numeric < schema.minimum) { errors.push(`${label} 不能小于 ${schema.minimum}`); return undefined }
    if (schema.maximum !== undefined && numeric > schema.maximum) { errors.push(`${label} 不能大于 ${schema.maximum}`); return undefined }
    return numeric
  }

  if (schema.type === 'boolean') {
    if (typeof input === 'boolean') return input
    if (input === 'true') return true
    if (input === 'false') return false
    errors.push(`${label} 必须是布尔值`)
    return undefined
  }

  if (schema.type === 'array') {
    if (!Array.isArray(input)) { errors.push(`${label} 必须是数组`); return undefined }
    return input
  }

  return input
}
