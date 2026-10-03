import crypto from 'node:crypto'
import fs from 'node:fs'
import { chromium } from 'playwright-core'

const sessions = new Map()
const TTL_MS = 5 * 60 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function isPortal(context) {
  for (const page of context.pages()) {
    const count = await page.getByText('当前学期课程', { exact: true }).count().catch(() => 0)
    if (count) return page
  }
  return null
}

async function clickCampusCard(context) {
  for (const page of context.pages()) {
    for (const candidate of [
      page.locator('a.login_stu_a:visible').first(),
      page.getByText('校园卡用户', { exact: false }).first()
    ]) {
      if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
        await candidate.click()
        return
      }
    }
  }
}

async function clickQrTab(context) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      for (const frame of page.frames()) {
        const exactTab = frame.locator('#qrcode_panel_top_bar').first()
        if (await exactTab.count().catch(() => 0) && await exactTab.isVisible().catch(() => false)) {
          await exactTab.click()
          await frame.locator('#qrcode_panel').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
          await sleep(400)
          return
        }

        for (const label of ['QR Code', '扫码登录', '二维码登录', '北京大学 App']) {
          const candidate = frame.getByText(label, { exact: false }).first()
          if (await candidate.count().catch(() => 0) && await candidate.isVisible().catch(() => false)) {
            await candidate.click().catch(() => {})
            await sleep(800)
            return
          }
        }
      }
    }
    await sleep(250)
  }
}

async function screenshot(context) {
  const page = context.pages().at(-1)
  if (!page) return ''

  for (const frame of page.frames()) {
    const qrImage = frame.locator('#qrcode_panel img').first()
    if (await qrImage.count().catch(() => 0) && await qrImage.isVisible().catch(() => false)) {
      return 'data:image/png;base64,' + (await qrImage.screenshot({ type: 'png' })).toString('base64')
    }

    const qrPanel = frame.locator('#qrcode_panel').first()
    if (await qrPanel.count().catch(() => 0) && await qrPanel.isVisible().catch(() => false)) {
      return 'data:image/png;base64,' + (await qrPanel.screenshot({ type: 'png' })).toString('base64')
    }
  }

  return 'data:image/png;base64,' + (await page.screenshot({ type: 'png', fullPage: false })).toString('base64')
}

async function closeSession(id) {
  const entry = sessions.get(id)
  sessions.delete(id)
  try { await entry?.context?.close() } catch {}
  try { await entry?.browser?.close() } catch {}
}

export function createQrSessions({ env, store }) {
  async function start(ownerId) {
    await store.profile(ownerId)
    for (const [id, entry] of sessions) if (entry.ownerId === ownerId) await closeSession(id)
    const executablePath = env.COURSE_CHROME_PATH
    const browser = await chromium.launch({
      executablePath: executablePath || undefined,
      headless: true,
      env: Object.fromEntries(['PATH','HOME','LANG','LC_ALL','TZ','SYSTEMROOT','WINDIR'].filter(key => typeof env[key] === 'string').map(key => [key,env[key]]))
    })
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await context.newPage()
    try {
      await page.goto(env.COURSE_START_URL || 'https://course.pku.edu.cn/', {
        waitUntil: 'domcontentloaded', timeout: 90000
      })
      await clickCampusCard(context)
      await clickQrTab(context)
      const id = crypto.randomUUID()
      const expiresAt = Date.now() + TTL_MS
      sessions.set(id, { id, ownerId, browser, context, expiresAt })
      await store.markPku(ownerId, { mode: 'qr', status: 'connecting', last_error: '' })
      return { id, expiresAt: new Date(expiresAt).toISOString(), image: await screenshot(context) }
    } catch (error) {
      try { await context.close() } catch {}
      try { await browser.close() } catch {}
      throw error
    }
  }

  async function status(ownerId, id) {
    const entry = sessions.get(id)
    if (!entry || entry.ownerId !== ownerId) return { state: 'missing' }
    if (Date.now() > entry.expiresAt) {
      await closeSession(id)
      await store.markPku(ownerId, { status: 'needs_reauth', last_error: '扫码已过期' })
      return { state: 'expired' }
    }
    const portal = await isPortal(entry.context)
    if (portal) {
      const state = JSON.stringify(await entry.context.storageState())
      await store.savePkuSession(ownerId, state, { mode: 'qr', status: 'connected' })
      await closeSession(id)
      return { state: 'connected' }
    }
    return {
      state: 'waiting',
      expiresAt: new Date(entry.expiresAt).toISOString(),
      image: await screenshot(entry.context)
    }
  }

  return { start, status }
}
