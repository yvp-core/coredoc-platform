import Moya

enum RailsApi: TargetType {
  case getProfiles
  case updateBooking(id: Int)
  var path: String {
    switch self {
    case .getProfiles: return "/profiles"
    case .updateBooking(let id): return "/bookings/\(id)"
    }
  }
  var method: Moya.Method {
    switch self {
    case .getProfiles: return .get
    case .updateBooking: return .put
    }
  }
}
