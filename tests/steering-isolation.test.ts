// steering 打断信号用户隔离测试：不同账号的同名书互不打断
import { test, expect, describe } from "bun:test";
import { runAsUser } from "../src/api/storage";
import * as steering from "../src/api/steering";

const mkItem = () => ({ level: "L2" as const, summary: "测试打断", commandId: "cmd-x" });

describe("steering 打断信号用户隔离", () => {
  test("用户 A 请求打断只被用户 A 的同名书消费", () => {
    const item = mkItem();
    // A 请求打断
    runAsUser("alice", () => steering.requestInterrupt("同名书", item));
    // B 的同名书不应消费到（key 前缀用户）
    runAsUser("bob", () => {
      expect(steering.checkInterrupt("同名书")).toBeNull();
    });
    // A 自己可以消费
    runAsUser("alice", () => {
      const got = steering.checkInterrupt("同名书");
      expect(got).not.toBeNull();
      expect(got!.summary).toBe("测试打断");
    });
    // 消费后再次检查为空
    runAsUser("alice", () => {
      expect(steering.checkInterrupt("同名书")).toBeNull();
    });
  });

  test("requeue 同样按用户隔离", () => {
    const item = mkItem();
    runAsUser("alice", () => {
      steering.requeueInterrupt("书X", item);
    });
    runAsUser("bob", () => {
      expect(steering.checkInterrupt("书X")).toBeNull();
    });
    runAsUser("alice", () => {
      expect(steering.checkInterrupt("书X")).not.toBeNull();
    });
  });
});
