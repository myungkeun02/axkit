import type { InterviewQuestion } from './questions.js';

export const EN_QUESTIONS: readonly InterviewQuestion[] = [
  {
    id: 'focus_time',
    text: 'When is your head clearest during the day?',
    options: [
      { id: 'morning', label: 'Morning', fact: 'Focuses best in the morning' },
      { id: 'forenoon', label: 'Late morning', fact: 'Focuses best late in the morning' },
      { id: 'afternoon', label: 'Afternoon', fact: 'Focuses best in the afternoon' },
      { id: 'evening', label: 'Evening', fact: 'Focuses best in the evening' },
      { id: 'night', label: 'Night', fact: 'Focuses best at night' },
    ],
  },
  {
    id: 'reply_length',
    text: 'How long should my answers be?',
    options: [
      { id: 'one_line', label: 'One line', fact: 'Prefers answers in one short line' },
      { id: 'few_sentences', label: 'A few sentences', fact: 'Prefers answers of a few sentences' },
      { id: 'detailed', label: 'Fully detailed', fact: 'Prefers fully detailed answers' },
    ],
  },
  {
    id: 'notifications',
    text: 'How often would you like notifications?',
    options: [
      { id: 'important', label: 'Only important ones', fact: 'Wants notifications only for important things' },
      { id: 'few_times', label: 'A few a day', fact: 'Wants a few notifications a day' },
      { id: 'often', label: 'Often', fact: 'Is fine with frequent notifications' },
      { id: 'rare', label: 'Almost never', fact: 'Prefers almost no notifications' },
    ],
  },
  {
    id: 'commute',
    text: 'How do you usually get around?',
    options: [
      { id: 'transit', label: 'Public transit', fact: 'Gets around mostly by public transit' },
      { id: 'car', label: 'Car', fact: 'Gets around mostly by car' },
      { id: 'walk', label: 'Walk or bike', fact: 'Gets around mostly on foot or by bike' },
      { id: 'mixed', label: 'A mix', fact: 'Gets around by a mix depending on the day' },
    ],
  },
  {
    id: 'drink',
    text: 'What do you like to drink?',
    options: [
      { id: 'americano', label: 'Americano', fact: 'Enjoys americano' },
      { id: 'latte', label: 'Latte', fact: 'Enjoys latte' },
      { id: 'tea', label: 'Tea', fact: 'Prefers tea over coffee' },
      { id: 'none', label: 'Neither', fact: 'Drinks neither coffee nor tea' },
    ],
  },
  {
    id: 'meals',
    text: 'Anything you avoid in meals?',
    options: [
      { id: 'none', label: 'No restrictions', fact: 'Eats without restrictions' },
      { id: 'vegetarian', label: 'Vegetarian', fact: 'Eats vegetarian' },
      { id: 'no_spicy', label: 'No spicy food', fact: 'Does not eat spicy food' },
      { id: 'no_seafood', label: 'No seafood', fact: 'Does not eat seafood' },
      { id: 'quick', label: 'Quick and simple', fact: 'Usually eats quick and simple meals' },
    ],
  },
  {
    id: 'exercise',
    text: 'How do you exercise?',
    options: [
      { id: 'none', label: 'Rarely', fact: 'Rarely exercises' },
      { id: 'walk', label: 'Walks', fact: 'Exercises mainly by walking' },
      { id: 'gym', label: 'Gym', fact: 'Exercises at the gym' },
      { id: 'run_bike', label: 'Run or bike', fact: 'Exercises by running or biking' },
      { id: 'ball', label: 'Ball sports', fact: 'Plays ball sports' },
    ],
  },
  {
    id: 'weekend',
    text: 'How do you usually spend weekends?',
    options: [
      { id: 'rest', label: 'Resting at home', fact: 'Rests at home on weekends' },
      { id: 'outing', label: 'Going out', fact: 'Goes out on weekends' },
      { id: 'people', label: 'Seeing people', fact: 'Sees people on weekends' },
      { id: 'backlog', label: 'Catching up', fact: 'Catches up on backlog on weekends' },
    ],
  },
  {
    id: 'address_style',
    text: 'How should I talk to you when you are busy?',
    options: [
      { id: 'brief', label: 'Short and direct', fact: 'Prefers short, direct messages when busy' },
      { id: 'polite', label: 'Polite and formal', fact: 'Prefers polite, formal messages even when busy' },
      { id: 'casual', label: 'Casual', fact: 'Is fine with casual messages when busy' },
    ],
  },
  {
    id: 'reminder_timing',
    text: 'When would you like reminders?',
    options: [
      { id: 'just_before', label: 'Right before', fact: 'Prefers reminders right before an event' },
      { id: 'thirty_before', label: '30 minutes before', fact: 'Prefers reminders 30 minutes before' },
      { id: 'day_before', label: 'A day before', fact: 'Prefers reminders a day before' },
      { id: 'morning', label: 'Together in the morning', fact: 'Prefers reminders together in the morning' },
    ],
  },
  {
    id: 'briefing_detail',
    text: 'How detailed should the morning briefing be?',
    options: [
      { id: 'summary', label: 'A quick summary', fact: 'Wants a briefing that is a quick summary' },
      { id: 'schedule', label: 'Schedule and tasks', fact: 'Wants the briefing to include schedule and tasks' },
      { id: 'detailed', label: 'Everything', fact: 'Wants a fully detailed briefing' },
    ],
  },
];
