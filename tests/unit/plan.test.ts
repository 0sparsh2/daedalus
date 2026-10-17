import { describe, expect, it } from "vitest";
import { asList, normalizePlan } from "@/lib/plan";

describe("plan normalization (model output can have any shape)", () => {
  it("accepts arrays, JSON-encoded arrays and bullet text", () => {
    expect(asList(["Search a city", "7-day forecast"])).toEqual(["Search a city", "7-day forecast"]);
    expect(asList('["Search a city", "7-day forecast"]')).toEqual(["Search a city", "7-day forecast"]);
    expect(asList("- Search a city\n- 7-day forecast")).toEqual(["Search a city", "7-day forecast"]);
    expect(asList("1. Layout\n2) Data\n• Polish")).toEqual(["Layout", "Data", "Polish"]);
    expect(asList([{ title: "Search" }, { name: "Forecast" }, 3])).toEqual(["Search", "Forecast", "3"]);
  });

  it("never throws on partial or wrong input (this crashed the page once)", () => {
    expect(asList('["Search a city", "7-da')).toEqual(['["Search a city", "7-da']);
    expect(asList(undefined)).toEqual([]);
    expect(asList({ a: 1 })).toEqual([]);
    const p = normalizePlan({ title: "Weather", features: "Search a city\nForecast", steps: 42 });
    expect(p).toMatchObject({ title: "Weather", features: ["Search a city", "Forecast"], steps: [], questions: [] });
    expect(normalizePlan(null).features).toEqual([]);
  });
});
