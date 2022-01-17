import Database from 'better-sqlite3'
// Using better-sqlite3 because prepared statements are confusing in node-sqlite3. Also its supposedly faster. Also the syntax is better.
import { randomBytes, scryptSync } from 'crypto'

export default class MushDB {
  constructor ({ path }) {
    // We care about the database, the root user id (might be able to be a group id?), name of the guest user
    this.db = new Database(path)
    this.db.pragma('journal_mode=WAL')
    this.db.pragma('foreign_keys=true')
    // https://www.sqlite.org/wal.html
    // https://github.com/JoshuaWise/better-sqlite3/blob/HEAD/docs/performance.md
    this.db.function('scrypt', (password, salt) =>
      scryptSync(password, salt, 64).toString('hex')
    )
    this.db.function('in_array', (arr, id) =>
      JSON.parse(arr).includes(id) ? 1 : 0
    )
    this.initializeTables()
    this.initializeStatements()
  }

  initializeStatements () {
    const sql = this.sql()

    this._createThing = sql`INSERT INTO things (attributes) VALUES (json($attributes))`
    this._getThing = sql`SELECT * FROM things WHERE ref=$ref`

    this._addUser = sql`INSERT INTO users (name, password, salt, thingref) VALUES ($name, scrypt($password, $salt), $salt, $thingref)`
    this._setGroupOnUser = sql`UPDATE users SET groupref=$groupref WHERE ref=$ref`
    this._addGroup = sql`INSERT INTO groups (name, users, thingref) VALUES ($name, json($users), $thingref)`
    this._addPerms = sql`INSERT INTO permissions VALUES ($thingref, json($owners), json($readers), json($writers), json($destroyers))`

    this._signIn = sql`SELECT groupref, name FROM users where name=$name and password=scrypt($password, (SELECT salt FROM users where name=$name))`
    this._checkPerms = sql`SELECT in_array(owners, $groupref) as isOwner, in_array(readers, $groupref) as isReader, in_array(writers, $groupref) as isWriter, in_array(destroyers, $groupref) as isDestroyer FROM permissions WHERE thingref=$thingref`
  }

  initializeTables () {
    const sql = this.sql()

    sql`CREATE TABLE IF NOT EXISTS things (
      ref INTEGER PRIMARY KEY,
      attributes TEXT,
      payload BLOB
    )`.run()
    // things have an owner and attributes. Attributes are arbitrary like any object in a mush. User and Group attributes are stored as a thing.
    // Payload is just a helpful column for stuff like images I guess. Things that attributes isn't suited for, like Description would have been used for. (MUSH People - Description is best added as an Attribute.) Its there as a reminder that this can expand.
    // Attributes is stuff that would be an &whatever on a MUSH

    sql`CREATE TABLE IF NOT EXISTS users (
      ref INTEGER PRIMARY KEY,
      name TEXT UNIQUE, 
      password TEXT, 
      salt TEXT,
      thingref INTEGER REFERENCES things,
      groupref INTEGER REFERENCES groups
    )`.run()
    // This is just here to be a storage for passwords and dbrefs

    sql`CREATE TABLE IF NOT EXISTS groups (
      ref INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      users TEXT,
      thingref INTEGER REFERENCES things
    )`.run()
    // Stores a Group's name and its users.
    // Every user has a Group of the same name for ease of ownership purposes?

    sql`CREATE TABLE IF NOT EXISTS permissions(
      thingref INTEGER PRIMARY KEY REFERENCES things,
      owners TEXT,
      readers TEXT,
      writers TEXT,
      destroyers TEXT
    )`.run()
    // Lookup table that sees who can mess with a dbref and how
  }

  sql () {
    return strings => this.db.prepare(strings.join(''))
  }

  getPerms (thingref, { groupref }) {
    return Object.fromEntries(
      Object.entries(this._checkPerms.get({ thingref, groupref })).map(
        ([key, value]) => [key, Boolean(value)]
      )
    )
  }

  setPermissions (dbref, user, newPerms) {
    const { isWriter } = this.getPermissions(dbref, user)
    if (!isWriter) return null
    // update the permissions of the thing
  }

  constructPerms (thingref, groupref) {
    return {
      thingref,
      owners: JSON.stringify([groupref]),
      readers: JSON.stringify(['guest', groupref]),
      writers: JSON.stringify([groupref]),
      destroyers: JSON.stringify([groupref])
    }
  }

  // User functions add  new users to the list of things, and flag a User as online or offile and return a User object to the Library's User
  signUp (name, password) {
    const userthing = this._createThing.run({
      attributes: JSON.stringify({ name, type: 'user' }),
      payload: null
    })
    const groupthing = this._createThing.run({
      attributes: JSON.stringify({ name, type: 'group' }),
      payload: null
    })
    const user = this._addUser.run({
      name,
      password,
      thingref: userthing.lastInsertRowid,
      salt: randomBytes(16).toString('hex')
    })
    const group = this._addGroup.run({
      name,
      users: JSON.stringify([user.lastInsertRowid]),
      thingref: groupthing.lastInsertRowid
    })
    this._setGroupOnUser.run({
      ref: user.lastInsertRowid,
      groupref: group.lastInsertRowid
    })
    this._addPerms.run(
      this.constructPerms(userthing.lastInsertRowid, group.lastInsertRowid)
    )
    this._addPerms.run(
      this.constructPerms(groupthing.lastInsertRowid, group.lastInsertRowid)
    )
    return this.signIn(name, password)
  }

  signIn (name, password) {
    return this._signIn.get({ name, password })
  }

  // These functions all run through a Role Access Service before allowing interaction with the Thing associated with the dbref
  getThing (thingref, user) {
    const { isReader } = this.getPerms(thingref, user)
    if (!isReader) return null
    const thing = this._getThing.get({ ref: thingref })
    return {
      ...thing,
      attributes: JSON.parse(thing.attributes)
    }
  }

  set (dbref, user, attributes) {
    const { isWriter } = this.getPermissions(dbref, user)
    if (!isWriter) return null
    // set the thing's new attributes
  }

  create ({ groupref }, attributes) {
    // put new Thing into table with relevant attributes, and user assigned as its owner.
    // Attributes would be the arbitrary stuff.
    // Permissions is role based access stuff.
    const thing = this._createThing.run({
      attributes: JSON.stringify(attributes)
    })
    this._addPerms.run(this.constructPerms(thing.lastInsertRowid, groupref))
  }

  destroy (dbref, user, cascade) {
    const { isDestroyer } = this.getPermissions(dbref, user)
    if (!isDestroyer) return null
    // checks to see if user has Destroy permissions then destroys the thing associated to the dbref.
    // if cascade is true, it also deletes everything owned by the dbref
  }

  setOwner (dbref, oldUser, newUser) {}
  addReader (dbref, owner, newUser) {
    // add 'guest' user to make a Thing publicly visible by default
  }

  removeReader (dbref, owner, newUser) {}
  addWriter (dbref, owner, newUser) {}
  removeWriter (dbref, owner, newUser) {}
  addDestroyer (dbref, owner, newUser) {}
  removeDestroyer (dbref, owner, newUser) {}

  createGroup (user, attributes) {}
  updateGroup (dbref, user, attributes) {}
  destroyGroup (dbref, user, cascade) {}
}