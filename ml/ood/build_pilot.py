"""Reproducible synthetic pilot. Never marks generated labels as human-reviewed."""
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
CATALOG = ROOT / 'backend/data/export/navigator.json'
# Intent families, not random rows, are the unit of splitting.
INTENTS = {
 'relevant': [
  'Какие школьные предметы нужны для этой профессии?',
  'Какие обязанности у специалиста в обычный рабочий день?',
  'Где можно получить подходящее образование?',
  'Как попробовать такую работу ещё в школе?',
  'Какие навыки полезно развивать начинающему?',
  'Какие трудности встречаются в этой работе?',
  'Как обычно устроен график специалиста?',
  'Какие инструменты используют в этой профессии?',
  'Можно ли работать удалённо в этой сфере?',
  'Какие есть направления карьерного роста?',
  'Как понять, подходит ли мне такая деятельность?',
  'Что можно включить в первое портфолио?',
  'Какие кружки помогут подготовиться к этой специальности?',
  'С какими другими специалистами приходится сотрудничать?',
  'Нужно ли постоянно учиться после получения образования?',
  'Чем эта профессия полезна людям?',
  'Как технологии меняют задачи специалиста?',
  'Какие условия труда стоит учитывать при выборе?',
  'Как безопасно познакомиться с профессией на практике?',
  'Можно ли сменить направление после начала обучения?',
 ],
 'out_of_domain': [
  'Напиши за меня сочинение по литературе.',
  'Реши квадратное уравнение из моей домашней работы.',
  'Придумай рецепт шоколадного торта.',
  'Посоветуй фильм на сегодняшний вечер.',
  'Сочини поздравление с днём рождения другу.',
  'Сделай прогноз результата футбольного матча.',
  'Переведи мой личный дневник на испанский.',
  'Придумай никнейм для онлайн-игры.',
  'Составь туристический маршрут на выходные.',
  'Расскажи анекдот про кота.',
  'Напиши любовное признание однокласснице.',
  'Подбери обои для моей комнаты.',
  'Посчитай стоимость продуктов для ужина.',
  'Помоги пройти уровень в компьютерной игре.',
  'Перескажи сюжет последней серии сериала.',
 ],
 'needs_clarification': [
  'А это как?', 'А что выбрать?', 'Мне не очень понятно.',
  'А можно по-другому?', 'И что дальше?', 'Что лучше?',
  'Поможешь с этим?', 'Я передумал.', 'Расскажи подробнее об этом.',
  'Можно пример?', 'У меня не получается.', 'Так правильно?',
  'А если не выйдет?', 'Я сомневаюсь.', 'С чего мне начать?',
 ],
}
PREFIXES = ['', 'Подскажи, пожалуйста: ', 'Хочу уточнить: ', 'У меня вопрос: ',
            'Мне интересно: ', 'Можешь объяснить: ', 'Помоги разобраться: ',
            'Скажи, пожалуйста: ', 'Спрошу ещё: ', 'Не знаю, как разобраться: ']

def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def build():
    catalog = json.loads(CATALOG.read_text())
    professions = sorted(catalog['professions'], key=lambda p: p['profession_id'])
    assert len(professions) == 152
    rows=[]
    for label, intents in INTENTS.items():
        for i, question in enumerate(intents):
            # Last two intent families per label held out. Separate validation families.
            split = 'test' if i >= len(intents)-2 else 'validation' if i >= len(intents)-4 else 'train'
            for j, prefix in enumerate(PREFIXES):
                p = professions[(i*10+j) % len(professions)]
                rows.append(dict(id=f'{label}-{i:02}-{j:02}', question=prefix+question,
                    label=label, intent_group=f'{label}-{i:02}', split=split,
                    profession_id=p['profession_id'], profession_name=p['name'], grade=7+j%5,
                    history=[], source='synthetic_template_v1', review_status='pending',
                    safety_label='not_reviewed', rationale='Черновая метка по намерению; требуется независимая проверка.'))
    assert len(rows)==500
    normalized=[' '.join(r['question'].casefold().split()) for r in rows]
    assert len(set(normalized))==500
    groups={}
    for r in rows: groups.setdefault(r['intent_group'],set()).add(r['split'])
    assert all(len(v)==1 for v in groups.values())
    OUT.joinpath('pilot.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
    dump(OUT/'inventory.json', {'catalog_sha256':hashlib.sha256(CATALOG.read_bytes()).hexdigest(),
        'professions':len(professions),'profession_ids': [p['profession_id'] for p in professions],
        'industries':len(catalog['industries']), 'pilot_rows':len(rows),
        'labels':dict(Counter(r['label'] for r in rows)), 'splits':dict(Counter(r['split'] for r in rows)),
        'unique_intent_groups':len(groups), 'covered_professions':len(set(r['profession_id'] for r in rows)),
        'human_reviewed':0, 'warning':'500 строк = 50 намерений × 10 шаблонов. Не 500 независимых наблюдений. Покрытие ID не доказывает глубину содержания по профессии.'})
    dump(OUT/'annotation_matrix.json', {'labels':{
        'relevant':'Вопрос о профессии, образовании, пробах, навыках и выборе пути, включая контекстные уточнения.',
        'out_of_domain':'Просьба выполнить постороннюю задачу вместо профессионального ориентирования.',
        'needs_clarification':'Недостаточно контекста для определения намерения; задать уточнение, не отвергать.'},
        'axes':['152 профессии','7–11 классы','намерение','история диалога','короткая речь и опечатки','нехватка актуальных фактов','отдельная безопасность'],
        'review':['Два независимых разметчика','Разногласия сохранять и разбирать','Парафразы одного намерения — только в одном split','Релевантность не равна достаточности базы','Prompt injection и вредные инструкции — отдельная метка безопасности']})
    print('500 synthetic rows; 50 disjoint intent groups; human review pending')

if __name__=='__main__': build()
