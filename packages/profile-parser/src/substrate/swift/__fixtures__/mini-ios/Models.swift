import RealmSwift

class BookingDB: Object {
  @Persisted(primaryKey: true) var id: Int
  @Persisted var uuid: String
  @Persisted var synced: Bool
}
