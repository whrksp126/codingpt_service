// src/pages/CurriculumList.js
import Header from '../components/sections/Header';
import Main from '../components/sections/Main';
import { curriculumList } from '../assets/lesson_dummy/curriculumList';

const Sections = () => {
  const searchParams = new URLSearchParams(window.location.search);
  const curriculum_id = searchParams.get('curriculum_id');
  const curriculum = curriculumList.find((curriculum) => curriculum.id === Number(curriculum_id));
  

  return (
    <div 
      className="
        flex flex-col items-center justify-center
        mx-auto
      "
    >
      <Header curriculum={curriculum} />
      <Main curriculum={curriculum} />
    </div>
    
  );
};

export default Sections;
