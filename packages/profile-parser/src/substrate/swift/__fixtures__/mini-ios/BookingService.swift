import RealmSwift

class DI {
  static let shared = DI()
  var bookingService: BookingService { BookingService() }
}

class BookingService: DataService {
  typealias DBObject = BookingDB
  func fetchAll() -> [BookingDB] {
    return Array(realm.objects(BookingDB.self))
  }
  func sync() {
    let op = NetworkOperation(target: RailsApi.getProfiles, handler: handler)
    realm.safeWrite { realm.add(op) }
  }
}

class Coordinator {
  func start() {
    DI.shared.bookingService.fetchAll()
  }
}
