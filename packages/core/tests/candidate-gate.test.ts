import { describe, it, expect } from "vitest";
import { evaluateGate1, type CandidateItem } from "../src/algorithms/candidate-gate.js";

describe("Gate 1: Multilingual Syntactic and Coverage Gate (candidate-gate)", () => {
  const englishDoc = `
# Architecture Overview

Modern high-concurrency systems often combine different caching layers.
In our primary benchmark, PostgreSQL demonstrates strong ACID consistency across multi-table transactions under heavy write traffic.
We evaluated several supplementary tools (such as Redis, Memcached, and Aerospike) for session caching.
Some experimental features are listed below:
- Kafka stream
- Flink runner
- RocksDB cache

However, Redis was only tested in passing, whereas PostgreSQL was analyzed in full depth across 12 node clusters.
`;

  const chineseDoc = `
# 分布式架构深度分析

在本次评测中，TiDB 通过 Raft 协议在多节点一致性测试中表现优异，尤其是在网络分区恢复场景下。
我们测试了多种外围组件（包括 Redis、Etcd、Consul 等），但未做深度压测。
以下是候选组件：
- ZooKeeper 协调器
- Kafka 消息队列

最终确定 [[Redis]] 作为主缓存在生产落地。
`;

  it("filters out absent candidates", () => {
    const results = evaluateGate1(
      [{ entityName: "Elasticsearch", claim: "Elasticsearch index was tested." }],
      englishDoc,
      "en",
    );
    expect(results[0]?.verdict).toBe("AUTO_DISCARD");
    expect(results[0]?.reason).toBe("absent");
  });

  it("classifies parenthetical mentions without coverage as aside+named (AUTO_DISCARD)", () => {
    const results = evaluateGate1(
      [{ entityName: "Memcached", claim: "Memcached is fast", coverage: "named only" }],
      englishDoc,
      "en",
    );
    expect(results[0]?.position).toBe("aside");
    expect(results[0]?.verdict).toBe("AUTO_DISCARD");
    expect(results[0]?.reason).toBe("aside+named");
  });

  it("classifies parenthetical mentions with substantial coverage as aside+covered (DEFER_TO_SCRATCHPAD)", () => {
    const results = evaluateGate1(
      [{ entityName: "Memcached", claim: "Memcached is fast", coverage: "substantially covered" }],
      englishDoc,
      "en",
    );
    expect(results[0]?.position).toBe("aside");
    expect(results[0]?.verdict).toBe("DEFER_TO_SCRATCHPAD");
    expect(results[0]?.reason).toBe("aside+covered");
  });

  it("defers prose mentions with only named coverage to scratchpad (prose+named)", () => {
    // Redis appears in prose ("However, Redis was only tested in passing...")
    const results = evaluateGate1(
      [{ entityName: "Redis", claim: "Redis was tested in passing", coverage: "named only" }],
      englishDoc,
      "en",
    );
    expect(results[0]?.position).toBe("prose");
    expect(results[0]?.verdict).toBe("DEFER_TO_SCRATCHPAD");
    expect(results[0]?.reason).toBe("prose+named");
  });

  it("passes prose mentions with substantial coverage to Gate 2 (prose+covered)", () => {
    const results = evaluateGate1(
      [
        {
          entityName: "PostgreSQL",
          claim: "PostgreSQL demonstrates strong ACID consistency",
          coverage: "substantially covered",
        },
      ],
      englishDoc,
      "en",
    );
    expect(results[0]?.position).toBe("prose");
    expect(results[0]?.verdict).toBe("PASS_TO_GATE_2");
    expect(results[0]?.reason).toBe("prose+covered");
  });

  it("handles Chinese text with ideographic punctuation correctly", () => {
    const results = evaluateGate1(
      [
        {
          entityName: "TiDB",
          claim: "TiDB 通过 Raft 协议保证多节点一致性",
          coverage: "substantially covered",
        },
        { entityName: "Etcd", claim: "Etcd 作为外围组件", coverage: "named only" },
        { entityName: "Redis", claim: "Redis 作为主缓存落地", coverage: "named only" }, // Has explicit [[Redis]] in chineseDoc!
      ],
      chineseDoc,
      "zh",
    );

    // TiDB is in prose and covered -> PASS_TO_GATE_2
    expect(results[0]?.verdict).toBe("PASS_TO_GATE_2");
    expect(results[0]?.reason).toBe("prose+covered");

    // Etcd is inside （包括 Redis、Etcd、Consul 等） and named only -> AUTO_DISCARD
    expect(results[1]?.verdict).toBe("AUTO_DISCARD");
    expect(results[1]?.reason).toBe("aside+named");

    // Redis has explicit [[Redis]] -> PASS_TO_GATE_2 (explicit_wikilink)
    expect(results[2]?.verdict).toBe("PASS_TO_GATE_2");
    expect(results[2]?.reason).toBe("explicit_wikilink");
  });

  it("executes in < 1ms per candidate on average", () => {
    const batch: CandidateItem[] = Array.from({ length: 50 }, (_, i) => ({
      entityName: i % 2 === 0 ? "PostgreSQL" : `NonExistent${i}`,
      claim: `Claim for item ${i}`,
      coverage: i % 3 === 0 ? "substantially covered" : "named only",
    }));

    // Warm-up run to compile and cache regex expressions
    for (let r = 0; r < 5; r++) {
      evaluateGate1(batch, englishDoc, "en");
    }

    let minDuration = Infinity;
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      const results = evaluateGate1(batch, englishDoc, "en");
      const duration = performance.now() - start;
      if (duration < minDuration) minDuration = duration;
      expect(results.length).toBe(50);
    }

    // Cached execution is sub-millisecond (< 1.0ms per item per PRD Section 4.1)
    expect(minDuration / batch.length).toBeLessThan(1.0);
  });
});
