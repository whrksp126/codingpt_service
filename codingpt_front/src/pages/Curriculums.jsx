// src/pages/CurriculumList.js
import Header from '../components/curriculums/Header';
import Main from '../components/curriculums/Main';
import { curriculumList } from '../assets/lesson_dummy/curriculumList';

const Curriculums = () => {
  return (
    <div 
      className="
        flex flex-col items-center justify-center
        mx-auto
      "
    >
      <Header />
      <Main curriculumList={curriculumList} />
    </div>
  );
};

export default Curriculums;
