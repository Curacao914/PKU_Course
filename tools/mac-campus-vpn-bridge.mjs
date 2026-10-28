#!/usr/bin/env node
/**
 * Personal macOS bridge. CONNECT-only, local socket only. On the cloud side,
 * SSH -R binds the same port to 127.0.0.1, never to a public interface.
 * The media proxy is intentionally not a general-purpose school VPN gateway.
 */
import http from 'node:http'
import net from 'node:net'
import { execFileSync } from 'node:child_process'

const bindHost = '127.0.0.1'
const listenPort = 19091
const allowedDomains = ['pku.edu.cn']
const campusRouteProbe = '162.105.205.204'
let routeCache = {at:0,ok:false}

function campusConnected() {
  if(Date.now()-routeCache.at < 8000) return routeCache.ok
  let ok = false
  try {
    const out = execFileSync('/sbin/route',['-n','get',campusRouteProbe],{timeout:1500,encoding:'utf8'})
    ok = /^\s*interface:\s*utun\d+/m.test(out)
  } catch {}
  routeCache = {at:Date.now(),ok}
  return ok
}
export function allowedHost(host) {
  const canonical=String(host||'').trim().toLowerCase().replace(/\.$/,'')
  return allowedDomains.some(domain=>canonical===domain || canonical.endsWith('.'+domain))
}
const server=http.createServer((_req,res)=>{
 res.writeHead(405,{'cache-control':'no-store'});res.end('CONNECT only')
})
let active=0
server.on('connect',(req,client,head)=>{
 const target=String(req.url||'')
 const sep=target.lastIndexOf(':')
 const host=target.slice(0,sep)
 const port=Number(target.slice(sep+1))
 if(!allowedHost(host) || port!==443){
   client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return
 }
 if(!campusConnected()){
   client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return
 }
 if(active>=12){
   client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return
 }
 active++
 const upstream=net.connect({host,port})
 let connected=false,closed=false
 const finish=()=>{
   if(closed)return
   closed=true;active=Math.max(0,active-1)
   upstream.destroy();client.destroy()
 }
 upstream.setTimeout(120000)
 client.setTimeout(120000)
 upstream.once('connect',()=>{
   connected=true
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
   if(head.length)upstream.write(head)
   upstream.pipe(client)
   client.pipe(upstream)
 })
 upstream.on('error',()=>{
   if(!connected&&!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
   finish()
 })
 upstream.on('timeout',finish)
 client.on('timeout',finish)
 client.on('error',finish)
 client.on('close',finish)
 upstream.on('close',finish)
})
server.listen(listenPort,bindHost,()=>{
  console.log('CAMPUS_VPN_BRIDGE_READY localhost only')
})
