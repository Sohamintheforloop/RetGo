/**
 * Short plain-language notes shown in the app. This project is open source and meant for a small group of friends,
 * so these are brief notes, not a legal agreement. Change them if you ever share the app more widely.
 */
export const APP_NAME = 'Retro Game Auto-Patcher'

/** Bump this string whenever the notes change; people are asked to accept again. */
export const POLICY_VERSION = '2026-10-12'

export interface Clause {
  id: string
  title: string
  body: string
}

export const PRIVACY_CLAUSES: Clause[] = [
  {
    id: 'p1',
    title: 'What stays on your PC',
    body: 'The games, folders, tab names and settings you save are stored in this browser, on your own computer. Fix files and compatibility settings are applied locally. Nothing about your games is sent anywhere.',
  },
  {
    id: 'p2',
    title: 'Optional online help',
    body: 'Only if you press Send in Get help, the text you typed is sent, after file paths, emails, IP addresses and links are removed from it. It goes to an AI service for advice, to a public list for the community, or encrypted so that only the maintainers can read it. Private requests are end-to-end encrypted. AI and public requests are not.',
  },
  {
    id: 'p3',
    title: 'No accounts or tracking',
    body: 'There are no accounts, analytics or cookies. If you enter your own Groq key it is kept unencrypted in this browser and is only used to ask Groq on your behalf.',
  },
  {
    id: 'p4',
    title: 'Deleting your data',
    body: '"Delete my data" erases everything this app stored in the browser and asks the server to delete any help requests you sent. Backups next to your games belong to you: delete them yourself if you no longer need them.',
  },
]

export const TERMS_CLAUSES: Clause[] = [
  {
    id: 't1',
    title: 'Legally owned games only',
    body: 'Use this app only with games you own. It does not bypass copy protection or licence checks, and the developer does not condone piracy.',
  },
  {
    id: 't2',
    title: 'You are changing files on your own PC',
    body: 'The app asks before it changes anything and keeps backups, but you are responsible for your system. Do not use it on games with anti-cheat or online services whose rules forbid changed files.',
  },
  {
    id: 't3',
    title: 'Fix packs are third-party software',
    body: 'Some fixes are made by other people and are downloaded from their official release page when the app is built. They keep their own licences, are provided as they are, and may be flagged by antivirus because they hook into the game. The setup window shows each file and where it comes from.',
  },
  {
    id: 't4',
    title: 'No warranty',
    body: 'Provided as is, without any warranty. This is a hobby project shared among friends.',
  },
]
