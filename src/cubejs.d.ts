declare module 'cubejs' {
  export default class Cube {
    constructor(other?: Cube);
    move(algorithm: string): this;
    identity(): this;
    randomize(): this;
    asString(): string;
    solve(maxDepth?: number): string;
    isSolved(): boolean;
    static initSolver(): void;
    static scramble(): string;
    static fromString(str: string): Cube;
    static random(): Cube;
  }
}
