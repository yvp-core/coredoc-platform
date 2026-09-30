using System.Threading.Tasks;
using System.Linq;
using Microsoft.EntityFrameworkCore;
namespace Example;
public class Item { public int Id {get;set;} }
public class Store:DbContext { protected override void OnModelCreating(ModelBuilder b) { b.Entity<Item>().ToTable("items"); } }
public class Repository<TContext>(IDbContextFactory<TContext> factory) where TContext:DbContext {
 public async Task Read() { await using var context = await factory.CreateDbContextAsync(); await context.Set<Item>().ToListAsync(); }
 public async Task Add(Item item) { await using var context = await factory.CreateDbContextAsync(); context.Set<Item>().Add(item); }
 public void Wrong(Fake context) { context.Set<Item>().ToListAsync(); }
}
public class Fake { public FakeSet<T> Set<T>() => new(); }
public class FakeSet<T> { public void ToListAsync() {} }
