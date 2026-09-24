import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertNoInputValues,
  chooseLoginControls,
  describeUrl,
  passwordScore,
  sanitizeControl,
  templatePath,
  usernameScore
} from './login-core.mjs'

const field = (over = {}) => ({
  index: 0, tag: 'input', type: 'text', id: '', name: '', autocomplete: '',
  placeholder: '', ariaLabel: '', label: '', visible: true, disabled: false, ...over
})

test('chooseLoginControls picks the username and password fields among decoys', () => {
  const chosen = chooseLoginControls([
    field({ index: 0, id: 'username', name: 'username', autocomplete: 'username' }),
    field({ index: 1, type: 'password', id: 'password', name: 'password', autocomplete: 'current-password' }),
    field({ index: 2, id: 'smsCode', placeholder: '短信验证码' })
  ])
  assert.equal(chosen.username.index, 0)
  assert.equal(chosen.password.index, 1)
})

test('invisible, disabled and decoy-only forms yield no selection', () => {
  const hidden = chooseLoginControls([field({ id: 'username', visible: false })])
  assert.equal(hidden.username, null)

  const disabled = chooseLoginControls([field({ id: 'username', disabled: true })])
  assert.equal(disabled.username, null)

  const captchaOnly = chooseLoginControls([field({ id: 'captcha', label: '验证码' })])
  assert.equal(captchaOnly.username, null)
  assert.equal(captchaOnly.password, null)
})

test('scoring rewards strong signals and punishes OTP fields', () => {
  assert.ok(usernameScore(field({ autocomplete: 'username' })) >= 100)
  assert.ok(usernameScore(field({ id: 'smsCode', placeholder: '短信验证码' })) < 0)
  assert.ok(passwordScore(field({ type: 'password' })) >= 100)
  assert.ok(passwordScore(field({ type: 'password', label: '短信验证码' })) <= -100)
  assert.equal(userScoreOfHidden(), -1000)
})

function userScoreOfHidden() {
  return usernameScore(field({ visible: false }))
}

test('sanitizeControl lowercases field names and redacts sensitive metadata', () => {
  const safe = sanitizeControl(field({ index: 4, tag: 'INPUT', type: 'PASSWORD', id: 'session_token', name: 'password' }))
  assert.equal(safe.tag, 'input')
  assert.equal(safe.type, 'password')
  assert.match(safe.id, /^<REDACTED_META:[0-9a-f]{12}>$/)
  assert.equal(safe.name, 'password')
})

test('assertNoInputValues refuses reports carrying typed values or credentials', () => {
  assert.equal(assertNoInputValues({ controls: [{ id: 'username' }] }), true)
  assert.throws(() => assertNoInputValues({ controls: [{ id: 'username', value: 'alice' }] }), /input value/)
  assert.throws(() => assertNoInputValues({ headers: { authorization: 'x' } }), /credentials/)
})

test('describeUrl reports structure without leaking identifiers', () => {
  assert.deepEqual(describeUrl('https://course.pku.edu.cn/webapps/login?token=abc&course_id=42'), {
    origin: 'https://course.pku.edu.cn',
    pathTemplate: '/webapps/login',
    queryKeys: ['course_id', 'token']
  })
  assert.equal(
    templatePath('/x/12345/0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e/abcdefabcdefabcdefabcdef'),
    '/x/:number/:uuid/:token'
  )
  assert.deepEqual(describeUrl('not a url'), { origin: 'invalid', pathTemplate: '/invalid', queryKeys: [] })
})
