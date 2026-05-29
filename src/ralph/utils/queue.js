class Queue {
  constructor() {
    this.items = [];
  }

  enqueue(element) {
    this.items.push(element);
  }

  dequeue() {
    if (this.items.length === 0) {
      return undefined;
    }
    return this.items.shift();
  }

  peek() {
    if (this.items.length === 0) {
      return undefined;
    }
    return this.items[0];
  }

  get size() {
    return this.items.length;
  }

  get isEmpty() {
    return this.items.length === 0;
  }

  clear() {
    this.items = [];
  }
}

module.exports = { Queue };
