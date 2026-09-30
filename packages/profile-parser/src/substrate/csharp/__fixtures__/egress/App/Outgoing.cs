using System.Net.Http;
namespace Example;
public class Outgoing(IHttpClientFactory factory, Demo.Gateway sdk) {
 public async Task Run(string unknown) {
  var first = factory.CreateClient("first");
  await first.GetStringAsync("items");
  var second = factory.CreateClient("second");
  await second.GetAsync("/status");
  await first.GetStringAsync(unknown);
  sdk.Publish("message");
  var moved = factory.CreateClient("first");
  moved = factory.CreateClient("second");
  await moved.GetAsync("/ambiguous");
 }
 public void Local(LocalClient client) { client.GetStringAsync("/fake"); }
}
public class LocalClient { public string GetStringAsync(string path) => path; }