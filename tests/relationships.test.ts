import { describe, expect, test } from "bun:test";
import { extractRelationshipSubgraph, findRelationshipTarget } from "../src/shared/relationships";

const characters = [
  { id: "c1", name: "林墨", role: "主角", relations: { "沈夜（东厂）": "宿敌", "盟友": "温雪见" } },
  { id: "c2", name: "沈夜", role: "反派", relations: { 林墨: "宿敌" } },
  { id: "c3", name: "温雪见", role: "关键人物", relations: { 林墨: "盟友" } },
  { id: "c4", name: "路人", role: "配角", relations: {} },
];

describe("人物关系子图规范化", () => {
  test("兼容新旧关系格式并对双向边去重", () => {
    const graph = extractRelationshipSubgraph(characters)!;
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(graph.edges.map((edge) => edge.label).sort()).toEqual(["宿敌", "盟友"]);
  });

  test("模糊名称匹配后返回焦点及一跳邻居", () => {
    const graph = extractRelationshipSubgraph(characters, "林")!;
    expect(graph.focus).toBe("c1");
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(graph.edges).toHaveLength(2);
  });

  test("无关系焦点保留节点；不存在角色返回 null", () => {
    const empty = extractRelationshipSubgraph(characters, "路人")!;
    expect(empty.nodes).toEqual([{ id: "c4", name: "路人", role: "配角" }]);
    expect(empty.edges).toEqual([]);
    expect(extractRelationshipSubgraph(characters, "不存在")).toBeNull();
  });

  test("介词前缀脏键（与/同/和）仍能连线到真实角色", () => {
    const withPrefix = [
      { id: "c1", name: "林墨", role: "主角", relations: { "与沈夜": "宿敌", "与温雪见": "盟友" } },
      { id: "c2", name: "沈夜", role: "反派", relations: { "同林墨": "宿敌" } },
      { id: "c3", name: "温雪见", role: "关键人物", relations: { "和林墨": "盟友" } },
    ];
    const graph = extractRelationshipSubgraph(withPrefix)!;
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(graph.edges.map((edge) => edge.label).sort()).toEqual(["宿敌", "盟友"]);
  });

  test("findRelationshipTarget 支持前缀/别名/包含匹配", () => {
    expect(findRelationshipTarget(characters, "与沈夜")?.id).toBe("c2");
    expect(findRelationshipTarget(characters, "沈夜（东厂）")?.id).toBe("c2");
    expect(findRelationshipTarget(characters, "小林墨")?.id).toBe("c1"); // 别名归一：去「小」前缀
    expect(findRelationshipTarget(characters, "张三")).toBeUndefined();
  });
});
