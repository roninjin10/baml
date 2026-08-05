import { b, Person } from './main.baml';
const person: Person = { name: 'Ada' };
export const greeting = b.Greet(person);
