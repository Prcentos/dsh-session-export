/**
 * Debug helper: print the event-type histogram and the first events of one
 * session log. Not part of the plugin at runtime.
 *
 *   node test/inspect.mjs <session-log-file> [eventCount]
 */
import { decodeSessionText, parseEvents } from '../lib/export.mjs'

const file = process.argv[2]
const limit = Number(process.argv[3] ?? 4)
if (!file) {
  console.error('usage: node test/inspect.mjs <session-log-file> [eventCount]')
  process.exit(2)
}

const { text, frames, plain } = decodeSessionText(file)
const { events, bad } = parseEvents(text)
console.log(`frames=${frames} plain=${plain} bad=${bad} events=${events.length}`)

const types = {}
for (const event of events) types[event.type] = (types[event.type] ?? 0) + 1
console.log(JSON.stringify(types, null, 1))

const wanted = process.argv.includes('--type')
  ? process.argv[process.argv.indexOf('--type') + 1].split(',')
  : null

if (wanted !== null) {
  for (const type of wanted) {
    const matches = events.filter((event) => event.type === type).slice(0, limit)
    console.log(`===== ${type} (${events.filter((event) => event.type === type).length}) =====`)
    for (const event of matches) {
      console.log('---')
      console.log(JSON.stringify(event, null, 1).slice(0, 1800))
    }
  }
} else {
  for (const event of events.slice(0, limit)) {
    console.log('---')
    console.log(JSON.stringify(event, null, 1).slice(0, 1400))
  }
}
