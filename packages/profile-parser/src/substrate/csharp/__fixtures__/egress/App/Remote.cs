using Refit;
namespace Example;
public interface IRemoteApi { [Refit.Get("/messages/{id}")] Task<string> GetMessage(string id); }
public class Remote(IRemoteApi api, ILocalApi local) {
 public Task<string> Load() => api.GetMessage("id");
 public string Local() => local.GetMessage("id");
}
public interface ILocalApi { [Get("/fake/{id}")] string GetMessage(string id); }
public class GetAttribute(string path) : Attribute { }