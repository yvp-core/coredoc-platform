using Microsoft.EntityFrameworkCore;
using System.ComponentModel.DataAnnotations.Schema;
namespace Example;
public class Item {
  public int Id { get; set; }
  public int ParentId { get; set; }
  public Parent Parent { get; set; } = null!;
  public string? Embedding { get; set; }
  public string Transient { get; set; } = "";
}
[Table("parents")] public class Parent {
  public int Id { get; set; }
  public ICollection<Item> Items { get; set; } = [];
}
[Table("not_a_model")] public class Dto { public int Id { get; set; } }
public class Conflicting { public int Id { get; set; } }
public class Dynamic { public int Id { get; set; } }
public class Store : DbContext {
  protected override void OnModelCreating(ModelBuilder builder) {
    builder.Entity<Parent>().HasKey(p => p.Id);
    builder.Entity<Item>(b => {
      b.ToTable("items", "catalog");
      b.HasKey(x => x.Id);
      b.Property(x => x.Embedding).HasColumnName("embedding").HasColumnType("vector(3)");
      b.Ignore(x => x.Transient);
      b.HasOne(x => x.Parent).WithMany(p => p.Items).HasForeignKey(x => x.ParentId);
    });
    builder.Entity<Conflicting>().ToTable("first");
    builder.Entity<Conflicting>().ToTable("second");
    builder.Entity<Dynamic>().ToTable(Environment.MachineName);
  }
}
public class Repository(Store db) {
  public async Task Read() { await db.Set<Item>().Where(x => x.Id > 0).ToListAsync(); }
  public void Add(Item item) { var items = db.Set<Item>(); items.Add(item); }
  public void Memory(List<Item> items) { items.Add(new Item()); }
  public void Save() { db.SaveChanges(); }
}
public class FakeBuilder { public FakeBuilder Entity<T>() => this; public void ToTable(string value) {} }
public class FakeConfiguration { public void Configure(FakeBuilder builder) { builder.Entity<Dto>().ToTable("fake"); } }
